import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('guard',str(Path(__file__).resolve().parents[1]/'scripts/role_process_guard.py'))
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
class LeaseTests(unittest.TestCase):
 def test_owner_starttime_stale_and_missing_lease(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);proc=root/'proc';p=proc/'123';p.mkdir(parents=True)
   fields=['S']+['0']*18+['999'];(p/'stat').write_text('123 (fake owner) '+' '.join(fields))
   token='fixture';f=root/(token+'.json');data={'owner_pid':123,'owner_start':'999','heartbeat':1000}
   f.write_text(json.dumps(data));self.assertIsNone(guard.invalid_lease(token,root,proc,1100))
   self.assertIn('expired',guard.invalid_lease(token,root,proc,1200))
   data['owner_start']='998';f.write_text(json.dumps(data));self.assertEqual(guard.invalid_lease(token,root,proc,1100),'owner exited')
   f.unlink();self.assertEqual(guard.invalid_lease(token,root,proc,1100),'lease closed or missing')
 def test_zombie_is_not_live_identity(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'123';p.mkdir();(p/'stat').write_text('123 (zombie) '+' '.join(['Z']+['0']*18+['999']))
   self.assertIsNone(guard.identity(123,Path(d)))

class NotificationTests(unittest.TestCase):
 def test_daily_owner_notification_is_not_a_task(self):
  import sqlite3
  spec=importlib.util.spec_from_file_location('watch',str(Path(__file__).resolve().parents[1]/'scripts/role_process_watch.py'))
  watch=importlib.util.module_from_spec(spec);spec.loader.exec_module(watch)
  with tempfile.TemporaryDirectory() as d:
   watch.DB=Path(d)/'fixture.db'
   with sqlite3.connect(watch.DB) as db:
    db.executescript("CREATE TABLE users(id TEXT,role TEXT);INSERT INTO users VALUES('owner','owner');CREATE TABLE notifications(id TEXT,user_id TEXT,type TEXT,text TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);")
   watch.notify('fixture orphan');watch.notify('fixture repeat')
   with sqlite3.connect(watch.DB) as db:
    self.assertEqual(db.execute('select count(*) from notifications').fetchone()[0],1)
    self.assertEqual(db.execute('select type from notifications').fetchone()[0],'role_process_watch')

class UnmanagedTests(unittest.TestCase):
 def test_only_legacy_role_qa_in_taskflow_group_is_selected(self):
  import os
  with tempfile.TemporaryDirectory() as d:
   root=Path(d)
   def fixture(pid,exe,cgroup):
    p=root/str(pid);p.mkdir();(p/'status').write_text(f'Uid: {os.getuid()} {os.getuid()}\n')
    (p/'stat').write_text(f'{pid} (fixture) '+' '.join(['S']+['0']*18+['1']))
    (p/'environ').write_bytes(b'');(p/'cmdline').write_bytes(exe.encode()+b'\0')
    (p/'cgroup').write_text(cgroup)
   fixture(111,'/opt/google/chrome/chrome','0::/taskflow-server.service')
   fixture(112,'/bin/sleep','0::/taskflow-server.service')
   fixture(113,'/opt/google/chrome/chrome','0::/unrelated.service')
   self.assertEqual([r['pid'] for r in guard.processes(root)],[111])
   self.assertIn('unmanaged',guard.invalid_lease('unmanaged'))

if __name__=='__main__':unittest.main()
