import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import subprocess

from events import event_notice, collect, enqueue, deliver, open_state
from receiver import validate, create

class ReminderTests(unittest.TestCase):
    def test_selects_only_requested_transitions(self):
        base = dict(id='e1', task_id='t1', title='Example', actor='Builder', kind='state_changed', field='agent_state')
        for value, word in [('blocked','заблокирована'),('review','проверку')]:
            notice = event_notice(dict(base, to_value=value))
            self.assertIn(word, notice['title'])
            self.assertEqual(notice['mode'], 'normal')
        self.assertIsNone(event_notice(dict(base, to_value='in_progress')))
        self.assertIn('выполнена',event_notice(dict(base, field='status', to_value='completed'))['title'])
        self.assertIsNone(event_notice(dict(base, kind='plan_subtask_started', to_value='Researcher')))
        self.assertIn('Заминки',event_notice(dict(base,kind='orchestrator_woken',to_value='Blocked step'))['title'])
        self.assertIsNone(event_notice(dict(base, kind='commented', to_value='noise')))

    def test_step_block_and_review_block_are_included(self):
        for kind in ['subtask_blocked','review_run_blocked','plan_subtask_stalled_blocked']:
            self.assertIsNotNone(event_notice(dict(id=kind,task_id='t',title='T',actor='R',kind=kind,to_value='Reason')))
        row=dict(id='o',task_id='t',title='T',actor='R',kind='step_outcome',to_value=json.dumps({'outcome':'blocked','message':'needs input'}))
        self.assertIn('заблокирована',event_notice(row)['title'])

    def test_queue_retries_and_deduplicates(self):
        with tempfile.TemporaryDirectory() as d:
            state = open_state(Path(d)/'state.db', '2026-10-29 14:00:00')
            n = dict(key='event:1',mode='normal',title='T',notes='N')
            enqueue(state,[n,n])
            self.assertEqual(state.execute('select count(*) from outbox').fetchone()[0],1)
            with patch('events.send',side_effect=RuntimeError('Mac offline')):
                deliver(state,1000)
            self.assertEqual(state.execute('select delivered from outbox').fetchone()[0],0)
            with patch('events.send',return_value={'id':'apple:1'}) as send:
                deliver(state,2000)
                deliver(state,3000)
                self.assertEqual(send.call_count,1)
            state.close()

    def test_answer_cancels_pending_urgent_without_sounding(self):
        with tempfile.TemporaryDirectory() as d:
            state=open_state(Path(d)/'state.db','2026-10-29 14:00:00')
            notice=dict(key='question:q',mode='urgent',title='Q',notes='N')
            enqueue(state,[notice])
            enqueue(state,[dict(notice,queue_key='question-resolved:q',operation='complete')])
            self.assertEqual(state.execute("select delivered from outbox where key='question:q'").fetchone()[0],2)
            with patch('events.send',return_value={'completed':True}) as send:
                deliver(state,1000)
                self.assertEqual(send.call_count,1)
                self.assertEqual(send.call_args.args[0]['operation'],'complete')
            state.close()

    def test_resolution_never_creates_a_new_reminder(self):
        p=validate(dict(title='Q',key='question:q',operation='complete'))
        with patch('receiver.existing',return_value=None),patch('receiver.subprocess.run') as run:
            result=create(p)
        self.assertTrue(result['completed'])
        run.assert_not_called()

    def test_validation_rejects_naive_date_and_empty_title(self):
        with self.assertRaises(ValueError):
            validate(dict(title='',at='2026-10-30T11:00:00+03:00'))
        with self.assertRaises(ValueError):
            validate(dict(title='T',at='2026-10-30T11:00:00'))
        p=validate(dict(title='$(danger) \"quote\"',at='2026-10-30T11:00:00+03:00',mode='urgent',key='event:1'))
        self.assertEqual(p['title'],'$(danger) \"quote\"')
        self.assertEqual(p['mode'],'urgent')

    def test_urgent_failure_is_reported_not_silently_downgraded(self):
        p=validate(dict(title='T',at='2026-10-30T11:00:00+03:00',mode='urgent',key='u1'))
        with patch('receiver.existing',return_value=None), patch('receiver.subprocess.run',side_effect=subprocess.CalledProcessError(1,'shortcuts')):
            with self.assertRaises(subprocess.CalledProcessError):
                create(p)

    def test_collection_skips_history_and_owner_calls_deduplicates_coordination(self):
        c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
        c.executescript("""
          create table task_events(id,task_id,actor_id,kind,field,to_value,created_at);
          create table tasks(id,title,service_hidden);
          create table users(id,name,role,role_key);
          create table chats(id,title,created_by,subagent_role_id,branch_of_chat_id,created_at);
          create table chat_messages(id,from_user_id,message_type,steps,created_at);
          create table chat_questions(id,role_id,chat_id,payload_json,status,created_at);
          insert into users values('r','Researcher','agent','researcher'),('o','Max','owner',null);
          insert into tasks values('t','Task',0);
          insert into task_events values('old','t','r','state_changed','agent_state','blocked','2026-10-28 12:00:00');
          insert into task_events values('new','t','r','state_changed','agent_state','review','2026-10-29 15:00:00');
          insert into chats values('child','Room','r','r','parent','2026-10-29 15:00:00');
          insert into chats values('manual','Room','o','r','parent','2026-10-29 15:00:00');
        """)
        coordination={'question_id':'q','child_chat_id':'child','recipient_name':'Researcher','requester_name':'Builder','question':'Q'}
        c.execute('insert into chat_messages values(?,?,?,?,?)',('m','r','system',json.dumps({'coordination':coordination}),'2026-10-29 15:00:00'))
        notices=collect(c,'2026-10-29 14:00:00')
        self.assertEqual(len(notices),1)
        self.assertTrue(any(n['key']=='event:new' for n in notices))
        self.assertFalse(any('role-call:' in n['key'] for n in notices))
        c.execute('insert into chat_questions values(?,?,?,?,?,?)',('q','r','parent',json.dumps({'questions':[{'question':'Need your decision'}]}),'open','2026-10-29 15:01:00'))
        notices=collect(c,'2026-10-29 14:00:00')
        urgent=next(n for n in notices if n['key']=='question:q')
        self.assertEqual(urgent['mode'],'urgent')
        self.assertIn('Need your decision',urgent['notes'])
        c.execute("update chat_questions set status='answered'")
        notices=collect(c,'2026-10-29 14:00:00')
        resolution=next(n for n in notices if n.get('queue_key')=='question-resolved:q')
        self.assertEqual(resolution['operation'],'complete')

if __name__=='__main__':
    unittest.main()
