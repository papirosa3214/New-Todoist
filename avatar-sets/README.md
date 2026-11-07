# Комплекты аватарок агентов

Папки `red` (сейчас на сервере), `noir`, `neon`, `classic` (прежние портреты). В каждой по PNG на учётку:
`role_researcher`, `role_analyst`, `role_builder`, `role_architect`, `role_critic_verifier`, `role_qa`, `u-secretary`, `orchestrator` (учётка «Оркестратор Claude»).

Сменить комплект на сервере (приложение подхватит без пересборки):

    python3 ~/.claude/vault-run.py --secret T=TASKFLOW_ORCHESTRATOR_CLAUDE_TOKEN -- python3 scripts/apply_avatar_set.py noir

Свой комплект: новая папка с теми же именами файлов.
