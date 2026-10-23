import importlib.util
import io
import json
import os
from pathlib import Path
import contextlib
import sys
import tempfile
import time
import unittest

spec=importlib.util.spec_from_file_location('watch',str(Path(__file__).with_name('session-record-watch.py')))
watch=importlib.util.module_from_spec(spec);spec.loader.exec_module(watch)


def write_fake_bin(directory):
    """Стенд: подменяем loginctl и systemctl, чтобы проверить выбор и лимиты без живых сеансов."""
    bin_dir=Path(directory)/'bin';bin_dir.mkdir(parents=True,exist_ok=True)
    (bin_dir/'loginctl').write_text(
        '#!/bin/sh\n'
        'if [ "$1" = "list-sessions" ]; then cat "$FAKE_SESSIONS_FILE"; exit 0; fi\n'
        'if [ "$1" = "terminate-session" ]; then echo "$2" >> "$FAKE_TERMINATE_LOG"; exit 0; fi\n'
        'exit 0\n')
    (bin_dir/'systemctl').write_text(
        '#!/bin/sh\n'
        'if [ "$1" = "list-units" ]; then cat "$FAKE_UNITS_FILE" 2>/dev/null; exit 0; fi\n'
        'exit 0\n')
    for name in ('loginctl','systemctl'):
        (bin_dir/name).chmod(0o755)
    return bin_dir


class SelectionTests(unittest.TestCase):
    def test_only_empty_closing_of_target_uid(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'session-live.scope').mkdir()
            text='old 1000 maksim - - closing no -\nlive 1000 maksim - - closing no -\nactive 1000 maksim - - active no -\nother 1001 someone - - closing no -\n'
            self.assertEqual(watch.stale_sessions(text,root),['old'])
    def test_scope_units_parsed_from_systemctl_output(self):
        text=('session-11.scope loaded active abandoned Session 11 of User maksim\n'
              'session-12.scope loaded active running Session 12 of User maksim\n'
              'session-13.service loaded active running Something\n'
              'user-1000.slice loaded active active User and Session Slice\n')
        self.assertEqual(watch.parse_scope_units(text),{'session-11.scope','session-12.scope'})
    def test_cleanup_plan_prefers_scope_units_and_caps_terminations(self):
        scopes={'session-1.scope','session-2.scope'}
        ids=['1','2','3','4','5']
        stop,terminate=watch.plan_cleanup(ids,scopes,limit=2)
        self.assertEqual(stop,['1','2'])
        self.assertEqual(terminate,['3','4'])
    def test_cleanup_plan_without_scopes_terminates_only_bounded_amount(self):
        stop,terminate=watch.plan_cleanup(['a','b','c'],set(),limit=2)
        self.assertEqual(stop,[])
        self.assertEqual(terminate,['a','b'])


class LimitTests(unittest.TestCase):
    """Лимит terminate считается по остатку бюджета времени, а не по одному числу."""
    def test_allowance_is_zero_when_budget_is_already_spent(self):
        self.assertEqual(watch.terminate_allowance(time.time()-1,max_terminate=2000,cost=6,batch=8),0)
    def test_allowance_scales_with_remaining_time(self):
        deadline=time.time()+watch.RESERVE_SECONDS+6*3+1
        allowance=watch.terminate_allowance(deadline,max_terminate=2000,cost=6,batch=8)
        self.assertGreater(allowance,0)
        self.assertLessEqual(allowance,3*8)
    def test_allowance_never_exceeds_numeric_ceiling(self):
        deadline=time.time()+100000
        self.assertEqual(watch.terminate_allowance(deadline,max_terminate=2000,cost=6,batch=8),2000)
    def test_numeric_ceiling_is_raised_above_old_two_hundred(self):
        self.assertGreaterEqual(watch.MAX_TERMINATE,2000)
    def test_terminate_sessions_does_nothing_without_budget(self):
        result=watch.terminate_sessions(['1','2','3'],deadline=time.time()-1,max_terminate=2000,scopes=set())
        self.assertEqual(result['done'],0)
        self.assertEqual(result['planned'],0)
    def test_terminate_sessions_plans_within_deadline(self):
        deadline=time.time()+watch.RESERVE_SECONDS+6*2+1
        result=watch.terminate_sessions([str(i) for i in range(50)],deadline=deadline,max_terminate=2000,scopes=set())
        self.assertLessEqual(result['planned'],2*8)
        self.assertGreater(result['planned'],0)


class StandTests(unittest.TestCase):
    """Стенд: полный проход сторожа на фейковых сеансах."""
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        root=Path(self.tmp.name)
        self.sessions_dir=root/'sessions';self.sessions_dir.mkdir()
        self.cgroup=root/'cgroup';self.cgroup.mkdir()
        self.state=root/'state.json'
        self.sessions_file=root/'sessions.txt'
        self.units_file=root/'units.txt';self.units_file.write_text('')
        self.terminate_log=root/'terminated.txt'
        self.bin=write_fake_bin(root)
        self.env=dict(os.environ)
        self.env.update({'PATH':str(self.bin)+':'+os.environ.get('PATH',''),
                         'FAKE_SESSIONS_FILE':str(self.sessions_file),
                         'FAKE_UNITS_FILE':str(self.units_file),
                         'FAKE_TERMINATE_LOG':str(self.terminate_log),
                         'SESSION_WATCH_STATE':str(self.state),
                         'SESSION_WATCH_SESSIONS_DIR':str(self.sessions_dir),
                         'SESSION_WATCH_CGROUP':str(self.cgroup),
                         'SESSION_WATCH_NO_NOTIFY':'1',
                         'SESSION_WATCH_LIMIT':'3',
                         'SESSION_WATCH_BUDGET':'20',
                         'SESSION_WATCH_RESERVE':'1',
                         'SESSION_WATCH_TERMINATE_COST':'1',
                         'SESSION_WATCH_POLL_GAP':'1'})
        self.saved=dict(os.environ)
        os.environ.update(self.env)
        self.saved_argv=list(sys.argv)
        sys.argv=['session-record-watch.py']
        watch.STATE=self.state
        watch.CGROUP=self.cgroup
        watch.SESSIONS_DIR=str(self.sessions_dir)
        watch.LIMIT=3
        watch.RESERVE_SECONDS=1.0
        watch.TERMINATE_CALL_COST=1.0
        watch.POLL_GAP=1.0
        watch.MAX_TERMINATE=2000
    def tearDown(self):
        os.environ.clear();os.environ.update(self.saved)
        sys.argv[:]=self.saved_argv
        self.tmp.cleanup()

    def _sessions(self,ids):
        self.sessions_file.write_text(''.join('%s 1000 maksim - - closing no -\n'%i for i in ids))
    def _terminated(self):
        if not self.terminate_log.exists():return []
        return [l.strip() for l in self.terminate_log.read_text().splitlines() if l.strip()]

    def test_full_pass_closes_sessions_and_keeps_files_in_sessions_dir(self):
        self._sessions(['101','102','103'])
        for sid in ('101','102','103'):
            (self.sessions_dir/sid).write_text('{}')
        buf=io.StringIO()
        with contextlib.redirect_stdout(buf):
            code=watch.main()
        state=json.loads(self.state.read_text())
        # фейковый loginctl не убирает записи, поэтому проход честно уходит в тревогу
        self.assertEqual(code,1)
        self.assertEqual(state['before']['empty_closing'],3)
        # два круга terminate (первый и повторный) по 3 сессии
        self.assertEqual(len(self._terminated()),6)
        self.assertEqual(sorted(set(self._terminated())),['101','102','103'])
        # внутренние файлы состояния сеансов не удаляются — это штатный путь, а не правка systemd
        for sid in ('101','102','103'):
            self.assertTrue((self.sessions_dir/sid).exists())
        self.assertEqual(state.get('cleanup',{}).get('dropped_records',0),0)

    def test_state_file_written_even_when_pass_fails(self):
        self._sessions(['201','202','203'])
        buf=io.StringIO()
        with contextlib.redirect_stdout(buf):
            code=watch.main()
        state=json.loads(self.state.read_text())
        self.assertEqual(code,1)
        self.assertTrue(state.get('error'))
        self.assertIn('before',state)
        self.assertIn('attempts',state)
        self.assertIn('deadline_epoch',state)

    def test_pass_does_not_delete_session_record_files(self):
        self._sessions(['301'])
        (self.sessions_dir/'301').write_text('{}')
        buf=io.StringIO()
        with contextlib.redirect_stdout(buf):
            watch.main()
        self.assertTrue((self.sessions_dir/'301').exists())
        self.assertFalse(hasattr(watch,'drop_stale_records'))


if __name__=='__main__':unittest.main()
