import importlib.util
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).with_name('recover-canaries.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
ID = '00000000000000000000000008'
CONFIG = dict(region='gru', key=ID + '_' + 'a' * 52, issuer=r.AUTH + '/terrascale', project=ID, database='status-canary-gru')


class RecoveryTests(unittest.TestCase):
    def response(self, status, body=b'', location=None):
        headers = Message()
        headers['Content-Type'] = 'application/json'
        if location:
            headers['Location'] = location
        response = Mock(status=status, headers=headers)
        response.read.return_value = body
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        return response

    def test_401_json_is_unauthenticated_and_redirects_cannot_leak_bearers(self):
        setup = object.__new__(r.Setup)
        setup.http = SimpleNamespace(open=Mock(return_value=self.response(401, b'{"error":"unauthorized"}')))
        self.assertIsNone(setup.call(r.AUTH + '/terrascale/oauth/userinfo', statuses=(200, 401)))
        for target, token in [('http://auth.terrascale.tech/next', None), (r.AUTH + '/next', 'private-token')]:
            setup.http.open = Mock(return_value=self.response(302, location=target))
            with self.assertRaises(RuntimeError):
                setup.call(r.API + '/start', token=token)
            self.assertEqual(setup.http.open.call_count, 1)

    def test_live_mapping_excludes_negative_http_data_probes(self):
        catalog = {'regions': [{'clusters': [
            dict(id=ID, componentName='Data API', cluster='gru', regionCode='GRU'),
            dict(id=ID[:-1] + '9', componentName='Data API', cluster='canary', regionCode='GRU'),
            dict(id=ID[:-1] + 'A', componentName='Document API', cluster='gru', regionCode='GRU'),
        ]}]}
        payload = r.secret_payload({'gru': CONFIG}, catalog)['secrets']
        self.assertEqual(list(json.loads(payload['DATA_API_CANARY']['text'])), [ID[:-1] + '9'])
        self.assertEqual(list(json.loads(payload['TERRABASE_PROBES']['text'])), [ID[:-1] + 'A'])
        with self.assertRaises(RuntimeError):
            r.secret_payload({'gru': CONFIG, 'fra': dict(CONFIG, region='fra')}, catalog)

    def test_device_grant_prints_only_the_approval_and_polls_until_approved(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(r, 'STATE', Path(directory) / 'state.json'):
            setup = r.Setup()
            setup.call = Mock(side_effect=[
                dict(verification_uri=r.AUTH + '/ui/terrascale/device', user_code='ABCD-EFGH',
                     device_code='private-device', expires_in=600, interval=5),
                dict(error='authorization_pending'), dict(error='slow_down'),
                dict(access_token='private-grant', expires_in=900)])
            with patch.object(r.time, 'sleep') as sleep, redirect_stdout(io.StringIO()) as output:
                self.assertEqual(setup.admin_grant()['access_token'], 'private-grant')
            self.assertEqual(json.loads(output.getvalue()), {
                'approve': r.AUTH + '/ui/terrascale/device', 'user_code': 'ABCD-EFGH', 'expires_in': 600})
            self.assertNotIn('private-device', output.getvalue())
            self.assertEqual([c.args[0] for c in sleep.call_args_list], [5, 5, 10])
            self.assertEqual(r.STATE.stat().st_mode & 0o777, 0o600)
            r.os.close(setup.lock)

    def test_denied_device_grant_fails_without_retrying(self):
        setup = object.__new__(r.Setup)
        setup.state = {}
        setup.call = Mock(side_effect=[
            dict(verification_uri='u', user_code='c', device_code='d', expires_in=600), dict(error='access_denied')])
        with patch.object(r.time, 'sleep'), redirect_stdout(io.StringIO()), self.assertRaises(RuntimeError):
            setup.admin_grant()
        self.assertEqual(setup.call.call_count, 2)

    def test_canaries_live_in_the_administered_internal_organization_project(self):
        setup = object.__new__(r.Setup)
        other = '00000000000000000000000009'
        setup.call = Mock(side_effect=[
            dict(items=[dict(id=other, name='terrascale', role=None), dict(id=ID, name='terrascale', role='owner'),
                        dict(id='0' * 25 + 'A', name='Status Canary', role='owner')], next=None),
            dict(items=[dict(id=other, name='ts-dashboard'), dict(id='0' * 25 + 'B', name='ts-status')], next=None)])
        self.assertEqual(setup.internal_project({'access_token': 'grant'}), (ID, '0' * 25 + 'B'))
        setup.call = Mock(return_value=dict(items=[dict(id=ID, name='terrascale', role='member')], next=None))
        with self.assertRaises(RuntimeError):
            setup.internal_project({'access_token': 'grant'})

    def test_worker_secret_payload_is_stdin_only_and_subprocess_output_is_captured(self):
        args = ['cf', 'workers', 'secrets', 'bulk', '--worker', 'ts-status', '--file', '/dev/stdin']
        payload = json.dumps({'key': CONFIG['key']}).encode()
        with patch.object(r.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'{}')) as run:
            r.private(args, payload)
        self.assertEqual(run.call_args.kwargs['input'], payload)
        self.assertTrue(run.call_args.kwargs['capture_output'])
        self.assertNotIn(CONFIG['key'], ' '.join(run.call_args.args[0]))

    def test_failed_query_still_deletes_and_never_prints_key(self):
        setup = object.__new__(r.Setup)
        methods = []
        def call(url, method='GET', data=None, **kwargs):
            methods.append(method)
            if url.endswith('/oauth/token'):
                return {'access_token': 'private-token'}
            if url.endswith('/query'):
                raise RuntimeError('query failed')
            if method == 'DELETE':
                return dict(id=url.split('id=')[1], version='v1')
            if method == 'PUT':
                return dict(id=url.split('id=')[1], version='v1')
            return dict(id=url.split('id=')[1], state='value', document={'canary': 'marker'})
        setup.call = call
        with patch.object(r.secrets, 'token_hex', return_value='marker'), redirect_stdout(io.StringIO()) as output:
            with self.assertRaises(RuntimeError):
                setup.verify(CONFIG)
        self.assertEqual(methods[-1], 'DELETE')
        self.assertNotIn(CONFIG['key'], output.getvalue())


if __name__ == '__main__':
    unittest.main()
