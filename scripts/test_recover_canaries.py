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
        self.assertIsNone(setup.call(r.DASH + '/api/v1/auth/me', statuses=(200, 401)))
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

    def test_interrupted_signup_resumes_without_signup_or_another_code_request(self):
        setup = object.__new__(r.Setup)
        setup.state = {'password': 'private', 'pending_signup': dict(pending_token='pending', next='/authorize', started='2026-10-26T12:00:00+00:00')}
        identity = dict(email=r.ADDRESS, userId=ID)
        setup.call = Mock(side_effect=[None, b'<input name="next" value="/authorize">', None, b'ok', b'ok', identity])
        setup.save = Mock()
        setup.mail_code = Mock(return_value='123456')
        setup.login('mailbox-password')
        urls = [c.args[0] for c in setup.call.call_args_list]
        self.assertNotIn(r.AUTH + '/ui/terrascale/sign-up', urls)
        self.assertEqual(urls.count(r.AUTH + '/ui/terrascale/sign-up/verify'), 1)
        setup.mail_code.assert_called_once()
        self.assertEqual(setup.state['user_id'], ID)
        self.assertNotIn('pending_signup', setup.state)

    def test_existing_session_does_not_request_mail_and_state_is_private(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(r, 'STATE', Path(directory) / 'state.json'):
            setup = r.Setup()
            setup.call = Mock(return_value=dict(email=r.ADDRESS, userId=ID))
            setup.mail_code = Mock()
            setup.login('unused')
            setup.mail_code.assert_not_called()
            self.assertEqual(r.STATE.stat().st_mode & 0o777, 0o600)
            r.os.close(setup.lock)

    def test_changed_identity_discards_old_customer_grant(self):
        setup = object.__new__(r.Setup)
        setup.state = dict(user_id='previous-user', cli_grant={'access_token': 'old'})
        setup.save = Mock()
        setup.remember(dict(email=r.ADDRESS, userId=ID))
        self.assertNotIn('cli_grant', setup.state)

    def test_rejected_cached_grant_is_replaced_once_without_email(self):
        setup = object.__new__(r.Setup)
        setup.state = dict(password='private', cli_grant=dict(expires_at=10**12, access_token='old'))
        setup.save = Mock()
        setup.mail_code = Mock()
        setup.call = Mock(side_effect=[
            None, b'<input name="next" value="/device">', b'signed in',
            dict(user_code='device-code', device_code='private-device'), b'approved',
            dict(access_token='replacement', expires_in=900), dict(sub=ID), dict(access_token='project-token')])
        self.assertEqual(setup.customer_token(dict(userId=ID, organizationId=ID, projectId=ID)), 'project-token')
        setup.mail_code.assert_not_called()
        self.assertEqual(setup.state['cli_grant']['access_token'], 'replacement')
        urls = [c.args[0] for c in setup.call.call_args_list]
        self.assertEqual(urls.count(r.AUTH + '/terrascale/oauth/device'), 1)
        self.assertNotIn(r.AUTH + '/ui/terrascale/sign-up', urls)

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
