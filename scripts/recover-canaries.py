#!/usr/bin/env python3
"""Recover customer canaries; mailbox password is read only from stdin."""
import datetime as dt
import email
import email.header
import email.utils
import fcntl
import html.parser
import http.cookiejar
import imaplib
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

AUTH = 'https://auth.terrascale.tech'
DASH = 'https://dash.terrascale.tech'
API = 'https://api.terrascale.tech'
ADDRESS = 'mariogk+status-canary@terrascale.tech'
MAILBOX = 'mariogk@terrascale.tech'  # IMAP only; never an application identity.
STATE = Path.home() / '.local/state/ts-status/canaries.json'
STATUS = 'https://status.terrascale.tech'
DOCUMENT = '00000000000000000000000007'
SCOPES = ['documents:read', 'documents:write']


class Inputs(html.parser.HTMLParser):
    def __init__(self, page):
        super().__init__()
        self.values = {}
        self.feed(page.decode())

    def handle_starttag(self, tag, attributes):
        a = dict(attributes)
        if tag == 'input' and a.get('name'):
            self.values[a['name']] = a.get('value', '')


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
        self.jar = http.cookiejar.CookieJar()
        for c in self.state.get('cookies', []):
            self.jar.set_cookie(http.cookiejar.Cookie(**c))
        self.http = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), NoRedirect)

    def save(self):
        fields = ('version', 'name', 'value', 'port', 'port_specified', 'domain', 'domain_specified',
                  'domain_initial_dot', 'path', 'path_specified', 'secure', 'expires', 'discard',
                  'comment', 'comment_url', 'rfc2109')
        self.state['cookies'] = [dict({k: getattr(c, k) for k in fields}, rest=c._rest) for c in self.jar]
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
        authenticated = token is not None or any(k.lower() in ('authorization', 'cookie') for k in h)
        for _ in range(12):
            parsed = urllib.parse.urlsplit(url)
            if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.netloc not in {
                    urllib.parse.urlsplit(x).netloc for x in (AUTH, DASH, API, STATUS)}:
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

    def form(self, path, fields, statuses=(200,), page='/'):
        csrf = Inputs(self.call(DASH + page)).values['_csrf']
        return self.call(DASH + path, 'POST', dict(fields, _csrf=csrf), form=True, statuses=statuses,
                         headers={'Accept': 'application/json'})

    def login(self, mailbox_password):
        self.stage = 'dedicated customer sign-in'
        identity = self.call(DASH + '/api/v1/auth/me', statuses=(200, 401))
        if identity is None:
            fields = Inputs(self.call(DASH + '/login')).values
            if 'next' not in fields:
                identity = self.call(DASH + '/api/v1/auth/me', statuses=(200, 401))
                if identity is None:
                    raise RuntimeError('Dashboard login did not establish a session')
                self.remember(identity)
                return
            signed_in = None
            if self.state.get('password'):
                signed_in = self.call(AUTH + '/ui/terrascale/sign-in/password', 'POST',
                    dict(email=ADDRESS, password=self.state['password'], next=fields['next']),
                    form=True, statuses=(200, 302, 303, 401))
            if signed_in is None:
                pending = self.state.get('pending_signup')
                if pending is None:
                    # Session and password rejection can mean a wiped identity. One
                    # signup per previous user ID; ambiguous starts are never replayed.
                    previous = self.state.get('user_id', 'initial')
                    if self.state.get('signup_from') == previous:
                        raise RuntimeError('Signup already attempted for this identity; coordinate recovery')
                    self.state.update(password=secrets.token_urlsafe(36), signup_from=previous)
                    self.save()
                    started = dt.datetime.now(dt.timezone.utc)
                    page = self.call(AUTH + '/ui/terrascale/sign-up', 'POST',
                        dict(email=ADDRESS, password=self.state['password'], next=fields['next']), form=True)
                    pending = dict(pending_token=Inputs(page).values['pending_token'],
                                   next=fields['next'], started=started.isoformat())
                    self.state['pending_signup'] = pending
                    self.save()  # Persist the answer before mailbox polling can be interrupted.
                if pending.get('verification_sent'):
                    raise RuntimeError('Verification was dispatched; password recovery failed; do not replay code')
                code = pending.get('code') or self.mail_code(mailbox_password, dt.datetime.fromisoformat(pending['started']))
                pending.update(code=code, verification_sent=True)
                self.save()  # An uncertain verification must not replay a one-time code.
                self.call(AUTH + '/ui/terrascale/sign-up/verify', 'POST',
                    dict(email=ADDRESS, code=code, pending_token=pending['pending_token'], next=pending['next']),
                    form=True, statuses=(200, 302, 303))
            self.save()
            self.call(DASH + '/login')  # Dashboard owns client registration, PKCE and callback.
            identity = self.call(DASH + '/api/v1/auth/me')
        self.remember(identity)

    def remember(self, identity):
        if identity['email'] != ADDRESS:
            raise RuntimeError('Unexpected application identity')
        if self.state.get('user_id') != identity['userId']:
            self.state.pop('cli_grant', None)
        self.state.update(user_id=identity['userId'])
        self.state.pop('pending_signup', None)
        self.save()

    def mail_code(self, password, started):
        with imaplib.IMAP4_SSL('mailserver.purelymail.com', ssl_context=ssl.create_default_context(), timeout=20) as box:
            box.login(MAILBOX, password)
            box.select('INBOX', readonly=True)
            for attempt in range(6):
                _, ids = box.search(None, 'TO', '"' + ADDRESS + '"')
                for item in reversed(ids[0].split()[-10:]):
                    _, fetched = box.fetch(item, '(BODY.PEEK[HEADER.FIELDS (SUBJECT DATE TO)])')
                    for entry in fetched:
                        if not isinstance(entry, tuple):
                            continue
                        message = email.message_from_bytes(entry[1])
                        subject = str(email.header.make_header(email.header.decode_header(message.get('Subject', ''))))
                        sent = email.utils.parsedate_to_datetime(message['Date'])
                        match = re.search(r'(?<!\d)(\d{6})(?!\d)', subject)
                        if match and ADDRESS in message.get('To', '') and -5 <= (sent - started).total_seconds() <= 180:
                            return match[1]
                if attempt < 5:
                    time.sleep(5)
        raise RuntimeError('Fresh dedicated signup code not delivered; do not request another')

    def discover(self):
        self.stage = 'public region discovery'
        regions = self.call(API + '/v1/regions')['regions']
        if not regions or len(set(regions)) != len(regions) or not all(re.fullmatch('[a-z]{3}', r) for r in regions):
            raise RuntimeError('Invalid discovery')
        for region in regions:
            ready = self.call(API + '/readyz', region=region)
            if ready['region'] != region or ready['status'] != 'ready':
                raise RuntimeError('Readiness mismatch')
        return regions

    def provision(self, regions):
        self.stage = 'customer workspace setup'
        identity = self.call(DASH + '/api/v1/auth/me')
        if not identity['onboardingCompleted']:
            for step, values in [('account-information', {'displayName': 'Status Canary'}),
                                 ('payment-method', {'bypass': '1'}),
                                 ('project', {'name': 'status-canary', 'region': regions[0]})]:
                page = Inputs(self.call(DASH + '/onboarding')).values
                if page.get('step') == step:
                    self.form('/onboarding/step', dict(values, step=step), (303,), '/onboarding')
        identity = self.call(DASH + '/api/v1/auth/me')
        project = identity['projectId']
        self.state.update(project=project, organization=identity['organizationId'])
        self.save()
        token = self.customer_token(identity)
        grant = self.state['cli_grant']
        issuer = AUTH + '/terrascale'
        self.stage = 'replicated customer canary database'
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
        root = AUTH + '/v1/terrascale/organizations/' + identity['organizationId'] + '/projects/' + project + '/api-keys'
        metadata = self.call(root, token=grant['access_token'])['items']
        saved = self.state.get('canary')
        if not saved or saved['project'] != project or not any(
                k['id'] == saved['key'][:26] and k['database'] == name and k['project_id'] == project
                and sorted(k['scopes']) == SCOPES for k in metadata):
            self.stage = 'database-scoped customer credential'
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

    def customer_token(self, identity):
        self.stage = 'public customer device grant'
        issuer = AUTH + '/terrascale'
        client = '00000000000000000000000007'  # ts-auth's registered public ts-cli client.
        grant = self.state.get('cli_grant', {})
        valid = grant.get('expires_at', 0) > time.time() + 60
        if valid:
            user = self.call(issuer + '/oauth/userinfo', token=grant['access_token'], statuses=(200, 401))
            valid = user is not None and user['sub'] == identity['userId']
        if not valid:
            page = Inputs(self.call(AUTH + '/ui/terrascale/device')).values
            if 'next' in page:
                self.call(AUTH + '/ui/terrascale/sign-in/password', 'POST',
                          dict(email=ADDRESS, password=self.state['password'], next=page['next']),
                          form=True, statuses=(200, 302, 303))
            device = self.call(issuer + '/oauth/device', 'POST',
                               {'client_id': client, 'scope': 'openid email'}, form=True)
            self.call(AUTH + '/ui/terrascale/device', 'POST',
                      {'user_code': device['user_code'], 'decision': 'approve'}, form=True)
            grant = self.call(issuer + '/oauth/token', 'POST',
                      {'grant_type': 'urn:ietf:params:oauth:grant-type:device_code',
                       'client_id': client, 'device_code': device['device_code']}, form=True)
            grant['expires_at'] = time.time() + grant['expires_in']
            self.state['cli_grant'] = grant
            self.save()
        if self.call(issuer + '/oauth/userinfo', token=grant['access_token'])['sub'] != identity['userId']:
            raise RuntimeError('Customer grant identity mismatch')
        return self.call(issuer + '/oauth/token', 'POST',
                {'grant_type': 'urn:ietf:params:oauth:grant-type:token-exchange', 'client_id': client,
                 'subject_token': grant['access_token'], 'subject_token_type': 'urn:ietf:params:oauth:token-type:access_token',
                 'organization': identity['organizationId'], 'project': identity['projectId'],
                 'scope': 'databases:read databases:write documents:read documents:write'}, form=True)['access_token']

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
        password = sys.stdin.readline().rstrip('\r\n')
        if not password:
            raise RuntimeError('Mailbox password required on stdin')
        setup.stage = 'Cloudflare permission preflight'
        if not json.loads(private(['cf', 'auth', 'whoami']))['authenticated']:
            raise RuntimeError('Cloudflare unauthenticated')
        private(['cf', 'workers', 'secrets', 'list', '--worker', 'ts-status'])
        regions = setup.discover()
        print('PLAN: reuse dedicated identity and all-regions canary database; verify pinned CRUD; bulk update only two ts-status secrets.', flush=True)
        setup.login(password)
        configurations = setup.provision(regions)
        setup.stage = 'Worker secret installation'
        payload = json.dumps(secret_payload(configurations, setup.call(STATUS + '/api/v1/regions'))).encode()
        private(['cf', 'workers', 'secrets', 'bulk', '--worker', 'ts-status', '--file', '/dev/stdin'], payload)
        print(json.dumps({'installed': ['DATA_API_CANARY', 'TERRABASE_PROBES'], 'regions': regions,
                          'organization': setup.state['organization'], 'project': setup.state['project'],
                          'database_id': setup.state['database_id']}))
        return 0
    except Exception as error:
        # Exception repr, HTTP bodies, subprocess stderr and cookies may contain secrets.
        print(json.dumps({'failed_stage': setup.stage if setup else 'private state', 'error_type': type(error).__name__,
                          'last_http_status': getattr(setup, 'last_status', None),
                          'operation': getattr(setup, 'last_operation', None),
                          'error_code': getattr(setup, 'last_error_code', None),
                          'recovery': 'Retain private state; rerun after resolving the cause. Never delete the canary identity.'}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
