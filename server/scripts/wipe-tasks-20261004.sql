-- Зачистка задач и чата на .110 (владелец 04.10.2026).
-- Остаются: проекты, документы (user_notes/notes), память, роли и учётки,
-- журнал работ, словари. Удаляем задачи и всё, что на них висит, плюс чат.
BEGIN;

DELETE FROM chat_message_reactions;
DELETE FROM chat_reads;
DELETE FROM chat_members;
DELETE FROM chat_sessions;
DELETE FROM chat_task_drafts;
DELETE FROM chat_messages;
DELETE FROM chats;

DELETE FROM slot_topic_inbox;
DELETE FROM slot_sessions;
DELETE FROM slot_work_snapshots;

DELETE FROM plan_topic_events;
DELETE FROM plan_event_journal;
DELETE FROM task_collaboration_plan_ops;
DELETE FROM task_collaboration_plan_edges;
DELETE FROM task_collaboration_plan_nodes;
DELETE FROM task_collaboration_plans;

DELETE FROM branch_rework_links;
DELETE FROM branch_plan_members;

DELETE FROM subtask_artifact_versions;
DELETE FROM artifact_versions;
DELETE FROM reviews;
DELETE FROM consultation_log;
DELETE FROM attempt_retries;
DELETE FROM attempts;
DELETE FROM subtasks;

DELETE FROM comments;
DELETE FROM task_events;
DELETE FROM task_dependencies;
DELETE FROM task_embeddings;
DELETE FROM task_external_mappings;
DELETE FROM task_labels;
DELETE FROM linear_import_relations;
DELETE FROM linear_import_tasks;
DELETE FROM linear_import_previews;
DELETE FROM linear_import_objects;
DELETE FROM task_preparation_jobs;
DELETE FROM live_activity_tokens;
DELETE FROM task_reports;
DELETE FROM notifications;
DELETE FROM role_run_jobs;
DELETE FROM enrichment_escalations;
DELETE FROM agent_inbox;

-- Только вложения, привязанные к задаче/комментарию/сообщению чата:
-- 48 «сиротских» строк без привязки не трогаем.
DELETE FROM attachments
 WHERE task_id IS NOT NULL OR comment_id IS NOT NULL OR chat_message_id IS NOT NULL;

DELETE FROM tasks;

COMMIT;
