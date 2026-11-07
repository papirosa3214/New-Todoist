import unittest
from unittest.mock import patch
import mcp_server as m
from task_brief import CONTRACT, INSTRUCTIONS, description, instruction

class TaskBriefTests(unittest.TestCase):
    def test_fields_render_and_parent_is_sent(self):
        brief = dict(work='Сделать предпросмотр', result='Нативный экран', acceptance='Правки сохранены', boundaries='Без запуска агентов')
        with patch.object(m, 'api', return_value={'task':{'id':'child','title':'Предпросмотр'}}) as api:
            m.t_create_task({'title':'Предпросмотр','brief':brief,'parent_id':'parent'})
        body = api.call_args.args[2]
        self.assertEqual(body['parent_id'], 'parent')
        for value in brief.values(): self.assertIn(value, body['description'])
        self.assertEqual(body['description'].count('## '), 4)
    def test_role_plan_nodes_are_preserved(self):
        brief = dict(work='Сделать', result='Результат', acceptance='Проверить', boundaries='Без изменений API')
        plan = {'representation':'role_plan'}
        with patch.object(m, 'api', return_value={'task':{'id':'plan','title':'Команда'}}) as api:
            m.t_create_task({'title':'Команда','brief':brief,'preparation':plan,'subtasks':['Исследование','Реализация']})
        body = api.call_args.args[2]
        self.assertEqual(body['preparation'], plan)
        self.assertEqual(body['subtasks'], ['Исследование','Реализация'])
    def test_incomplete_request_never_writes(self):
        for args in ({'title':'Task'}, {'title':'Task','description':'Что-нибудь'}, {'title':'Task','brief':{'work':'Работа'}}):
            with patch.object(m, 'api') as api:
                with self.assertRaises(ValueError): m.t_create_task(args)
                api.assert_not_called()
    def test_markdown_accepts_complete_but_rejects_empty_sections(self):
        complete = '\n\n'.join('## '+title+'\n\nСодержимое' for title in CONTRACT['sections'].values())
        self.assertEqual(description({'description':complete}), complete)
        with self.assertRaises(ValueError): description({'description':complete.replace('## Результат\n\nСодержимое','## Результат')})
    def test_snapshot_cannot_hide_creation_contract(self):
        with patch.object(m, 'instruction_text', return_value='Ручная инструкция'):
            tool = next(t for t in m.public_tools() if t['name']=='taskflow_create_task')
        self.assertIn(INSTRUCTIONS,tool['description'])
        self.assertIn('Ручная инструкция',tool['description'])
        self.assertEqual(instruction('mcp.initialize', instruction('mcp.initialize','Основа')).count(INSTRUCTIONS),1)
        self.assertIn('brief',tool['inputSchema']['properties'])
        self.assertIn('parent_id',tool['inputSchema']['properties'])
if __name__=='__main__': unittest.main()
