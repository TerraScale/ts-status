#!/usr/bin/env python3
"""Provision the status canaries in the internal organization, approved by its admin."""
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

AUTH = 'https://auth.terrascale.tech'
API = 'https://api.terrascale.tech'
# TerraScale's own organization: its internal plan keeps the monitor's writes off the Free allowance.
ORGANIZATION = 'terrascale'
PROJECT = 'ts-status'
CLI_CLIENT = '00000000000000000000000007'  # ts-auth's registered public ts-cli client.
STATE = Path.home() / '.local/state/ts-status/canaries.json'
STATUS = 'https://status.terrascale.tech'
DOCUMENT = '00000000000000000000000007'
SCOPES = ['documents:read', 'documents:write']


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def private(args, payload=None):
    result = subprocess.run(args, input=payload, capture_output=True, timeout=90)
    if result.returncode:
        raise RuntimeError('Private command failed: ' + ' '.join(args[:4]))
    return result.stdout


class Setup:
    def __init__(self):
        self.stage = 'initialization'
        STATE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.lock = os.open(STATE.with_suffix('.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if STATE.exists() and (STATE.is_symlink() or STATE.stat().st_mode & 0o777 != 0o600 or STATE.stat().st_uid != os.getuid()):
            raise RuntimeError('Private state must be owned by this user with mode 0600')
        self.state = json.loads(STATE.read_text()) if STATE.exists() else {}
        self.http = urllib.request.build_opener(NoRedirect)

    def save(self):
        self.state.pop('cookies', None)
        temporary = STATE.with_suffix('.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(self.state, stream)
        temporary.replace(STATE)

    def call(self, url, method='GET', data=None, token=None, form=False, statuses=(200,), region=None, headers=None):
        h = {'User-Agent': 'ts-status-canary-recovery/1.0', **(headers or {})}
        if token:
            h['Authorization'] = 'Bearer ' + token
        if region:
            h['X-TerraScale-Region-Pin'] = region
        body = None
        if data is not None:
            h['Content-Type'] = 'application/x-www-form-urlencoded' if form else 'application/json'
            body = (urllib.parse.urlencode(data, doseq=True) if form else json.dumps(data)).encode()
            h['Origin'] = urllib.parse.urlsplit(url).scheme + '://' + urllib.parse.urlsplit(url).netloc
        original = urllib.parse.urlsplit(url).netloc
        authenticated = token is not None or any(k.lower() == 'authorization' for k in h)
        for _ in range(12):
            parsed = urllib.parse.urlsplit(url)
            if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.netloc not in {
                    urllib.parse.urlsplit(x).netloc for x in (AUTH, API, STATUS)}:
                raise RuntimeError('Unadvertised or insecure redirect refused')
            if authenticated and parsed.netloc != original:
                raise RuntimeError('Authenticated cross-origin redirect refused')
            try:
                response = self.http.open(urllib.request.Request(url, body, h, method=method), timeout=30)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                self.last_status = response.status
                self.last_operation = method + ' ' + parsed.path
                content = response.read(1_048_577)
                if response.status in (302, 303) and method == 'GET':
                    url = urllib.parse.urljoin(url, response.headers['Location'])
                    continue
                if response.status == 401 and 401 in statuses:
                    return None
                if response.status not in statuses or len(content) > 1_048_576:
                    try:
                        code = json.loads(content).get('error', {}).get('code')
                        self.last_error_code = code if code in {'remote_region_unavailable', 'unknown_project', 'forbidden_scope', 'temporarily_unavailable', 'insufficient_scope', 'upstream_unavailable', 'not_found', 'internal_error', 'invalid_client', 'invalid_grant', 'rate_limited'} else None
                    except (ValueError, AttributeError):
                        self.last_error_code = None
                    raise RuntimeError('HTTP ' + str(response.status) + ' at ' + urllib.parse.urlsplit(url).path)
                if region and url.startswith(API) and response.headers.get('X-TerraBase-Region') != region:
                    raise RuntimeError('Serving region mismatch')
                if response.status in (302, 303):
                    return response.headers['Location']
                return json.loads(content) if response.headers.get_content_type() == 'application/json' else content
        raise RuntimeError('Redirect limit exceeded')

    def admin_grant(self):
        """A ts-cli device grant the internal organization's admin approves in a browser."""
        self.stage = 'internal organization admin device grant'
        issuer = AUTH + '/terrascale'
        grant = self.state.get('cli_grant', {})
        if grant.get('expires_at', 0) > time.time() + 60 and self.call(
                issuer + '/oauth/userinfo', token=grant['access_token'], statuses=(200, 401)) is not None:
            return grant
        device = self.call(issuer + '/oauth/device', 'POST', {'client_id': CLI_CLIENT, 'scope': 'openid email'}, form=True)
        # The user code is single-use and useless without the browser approval; the device code stays private.
        print(json.dumps({'approve': device.get('verification_uri_complete') or device['verification_uri'],
                          'user_code': device['user_code'], 'expires_in': device['expires_in']}), flush=True)
        interval = max(5, int(device.get('interval', 5)))
        deadline = time.time() + device['expires_in']
        while time.time() < deadline:
            time.sleep(interval)
            answer = self.call(issuer + '/oauth/token', 'POST',
                               {'grant_type': 'urn:ietf:params:oauth:grant-type:device_code',
                                'client_id': CLI_CLIENT, 'device_code': device['device_code']},
                               form=True, statuses=(200, 400))
            if 'access_token' in answer:
                answer['expires_at'] = time.time() + answer['expires_in']
                self.state['cli_grant'] = answer
                self.save()
                return answer
            if answer.get('error') == 'slow_down':
                interval += 5
            elif answer.get('error') != 'authorization_pending':
                raise RuntimeError('Device approval ended: ' + str(answer.get('error'))[:40])
        raise RuntimeError('Device approval expired')

    def internal_project(self, grant):
        """The internal organization's ts-status project, which the caller administers."""
        self.stage = 'internal organization discovery'
        def listing(url):
            items, after = [], None
            while True:
                page = self.call(url + ('?after=' + urllib.parse.quote(after) if after else ''), token=grant['access_token'])
                items.extend(page['items'])
                after = page['next']
                if not after:
                    return items
        organizations = [o for o in listing(AUTH + '/v1/terrascale/organizations')
                         if o['name'] == ORGANIZATION and o['role'] in ('owner', 'admin')]
        if len(organizations) != 1:
            raise RuntimeError('The approving account must administer exactly one internal organization')
        organization = organizations[0]['id']
        projects = [p for p in listing(AUTH + '/v1/terrascale/organizations/' + organization + '/projects')
                    if p['name'] == PROJECT]
        if len(projects) != 1:
            raise RuntimeError('The internal organization lacks its ts-status project')
        return organization, projects[0]['id']

    def project_token(self, grant, organization, project):
        return self.call(AUTH + '/terrascale/oauth/token', 'POST',
                {'grant_type': 'urn:ietf:params:oauth:grant-type:token-exchange', 'client_id': CLI_CLIENT,
                 'subject_token': grant['access_token'], 'subject_token_type': 'urn:ietf:params:oauth:token-type:access_token',
                 'organization': organization, 'project': project,
                 'scope': 'databases:read databases:write documents:read documents:write'}, form=True)['access_token']

    def provision(self, regions):
        grant = self.admin_grant()
        organization, project = self.internal_project(grant)
        self.state.update(project=project, organization=organization)
        self.save()
        token = self.project_token(grant, organization, project)
        issuer = AUTH + '/terrascale'
        self.stage = 'replicated canary database'
        base = API + '/v1/projects/' + project + '/databases'
        name = 'status-canary'
        existing = []
        after = None
        while True:
            page = self.call(base + ('?after=' + urllib.parse.quote(after) if after else ''),
                             token=token, region=regions[0], statuses=(200, 404))
            if 'items' not in page:
                if self.last_status != 404:
                    raise RuntimeError('Invalid database listing')
                break  # The first database registers a new auth project in TerraBase.
            existing.extend(d for d in page['items'] if d['name'] == name)
            after = page['next']
            if not after:
                break
        if len(existing) > 1:
            raise RuntimeError('Duplicate canary database')
        # allRegions is the producer's placement contract, always true; no operator toggle.
        database = existing[0] if existing else self.call(base, 'POST',
                {'name': name, 'homeRegion': regions[0], 'allRegions': True}, token=token,
                region=regions[0], statuses=(201,))
        self.state['database_id'] = database['id']
        self.save()
        self.call(base + '/' + name + '/collections', 'POST', {'name': 'canary'},
                  token=token, region=regions[0], statuses=(201, 409))
        root = AUTH + '/v1/terrascale/organizations/' + organization + '/projects/' + project + '/api-keys'
        metadata = self.call(root, token=grant['access_token'])['items']
        saved = self.state.get('canary')
        if not saved or saved['project'] != project or not any(
                k['id'] == saved['key'][:26] and k['database'] == name and k['project_id'] == project
                and sorted(k['scopes']) == SCOPES for k in metadata):
            self.stage = 'database-scoped canary credential'
            issued = self.call(root, 'POST', {'name': 'status-canary', 'database': name, 'scopes': SCOPES},
                               token=grant['access_token'], statuses=(201,))
            key = issued['api_key']
            if key['project_id'] != project or key['database'] != name or sorted(key['scopes']) != SCOPES:
                raise RuntimeError('Credential restrictions mismatch')
            saved = dict(origin=API, issuer=issuer, project=project, database=name,
                         collection='canary', document=DOCUMENT, key=issued['key'])
            self.state['canary'] = saved
            self.save()
        configurations = {region: dict(saved, region=region) for region in regions}
        for config in configurations.values():
            self.verify(config)
        return configurations

    def verify(self, config):
        self.stage = config['region'] + ' pinned CRUD'
        token = self.call(config['issuer'] + '/oauth/token', 'POST',
                         {'grant_type': 'client_credentials', 'client_id': config['key'][:26],
                          'client_secret': config['key'], 'project': config['project'], 'scope': ' '.join(SCOPES)}, form=True)['access_token']
        base = API + '/v1/projects/' + config['project'] + '/databases/' + config['database'] + '/collections/canary'
        def call(path, method='GET', data=None, statuses=(200,)):
            return self.call(base + path, method, data, token=token, region=config['region'], statuses=statuses)
        call('/documents/by-key?id=' + DOCUMENT, 'PUT', {'purpose': 'Persistent status read canary'}, (200, 201))
        if call('/documents/by-key?id=' + DOCUMENT)['state'] != 'value':
            raise RuntimeError('Fixture missing')
        # A canonical ULID using random bits; independent documents for concurrent executions.
        alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
        number = secrets.randbits(128)
        document = ''.join(alphabet[(number >> (5 * i)) & 31] for i in reversed(range(26)))
        path = '/documents/by-key?id=' + document
        marker = secrets.token_hex(16)
        try:
            written = call(path, 'PUT', {'canary': marker}, (201,))
            read = call(path)
            queried = call('/query', 'POST', {'filter': {'eq': ['$id', document]}, 'limit': 1})
            if (written['id'] != document or not written.get('version') or read['id'] != document
                    or read['state'] != 'value' or read['document']['canary'] != marker
                    or len(queried['items']) != 1 or queried['items'][0]['id'] != document
                    or queried['items'][0]['document']['canary'] != marker):
                raise RuntimeError('CRUD content mismatch')
        finally:
            deleted = call(path, 'DELETE')
            if deleted['id'] != document or not deleted.get('version'):
                raise RuntimeError('Delete acknowledgement mismatch')
        after = call(path, statuses=(200, 404))
        if isinstance(after, dict) and after.get('state') == 'value':
            raise RuntimeError('Delete not visible')
        print(json.dumps({'region': config['region'], 'project': config['project'], 'database': config['database'],
                          'key_id': config['key'][:26], 'proof': ['write', 'read', 'query', 'delete', 'read-after-delete']}), flush=True)


def secret_payload(configurations, catalog):
    maps = {'DATA_API_CANARY': {}, 'TERRABASE_PROBES': {}}
    for region in catalog['regions']:
        for cluster in region['clusters']:
            component = cluster['componentName']
            if component == 'Data API' and cluster['cluster'] == 'canary':
                name = 'DATA_API_CANARY'
            elif component == 'Document API':
                name = 'TERRABASE_PROBES'
            else:
                continue
            code = cluster['regionCode'].lower()
            endpoint = cluster['id']
            if not re.fullmatch('[0-7][0-9A-HJKMNP-TV-Z]{25}', endpoint):
                raise RuntimeError('Invalid live endpoint ID')
            if code in configurations:
                maps[name][endpoint] = configurations[code]
    if {c['region'] for c in maps['TERRABASE_PROBES'].values()} != set(configurations):
        raise RuntimeError('Live status catalog lacks a discovered document region; coordinate catalog update')
    if not maps['DATA_API_CANARY']:
        raise RuntimeError('Live status catalog lacks the retained Data API canary')
    return {'secrets': {name: {'type': 'secret_text', 'text': json.dumps(values)} for name, values in maps.items()}}


def main():
    setup = None
    try:
        setup = Setup()
        setup.stage = 'Cloudflare permission preflight'
        if not json.loads(private(['cf', 'auth', 'whoami']))['authenticated']:
            raise RuntimeError('Cloudflare unauthenticated')
        private(['cf', 'workers', 'secrets', 'list', '--worker', 'ts-status'])
        regions = setup.discover()
        print('PLAN: admin-approved device grant; all-regions canary database in the internal ts-status project; verify pinned CRUD; bulk update only two ts-status secrets.', flush=True)
        configurations = setup.provision(regions)
        setup.stage = 'Worker secret installation'
        payload = json.dumps(secret_payload(configurations, setup.call(STATUS + '/api/v1/regions'))).encode()
        private(['cf', 'workers', 'secrets', 'bulk', '--worker', 'ts-status', '--file', '/dev/stdin'], payload)
        print(json.dumps({'installed': ['DATA_API_CANARY', 'TERRABASE_PROBES'], 'regions': regions,
                          'organization': setup.state['organization'], 'project': setup.state['project'],
                          'database_id': setup.state['database_id']}))
        return 0
    except Exception as error:
        # Exception repr, HTTP bodies and subprocess stderr may contain secrets.
        print(json.dumps({'failed_stage': setup.stage if setup else 'private state', 'error_type': type(error).__name__,
                          'last_http_status': getattr(setup, 'last_status', None),
                          'operation': getattr(setup, 'last_operation', None),
                          'error_code': getattr(setup, 'last_error_code', None),
                          'recovery': 'Retain private state; rerun after resolving the cause.'}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
