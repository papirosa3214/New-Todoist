with open('server/scripts/trigger.py', 'r') as f:
    content = f.read()

target = '**({"cwd": str(HOME)} if claude_cli else {}),'
replacement = 'cwd=str(HOME) if claude_cli else str(HOME / "Проекты/New-Todoist"),'

if target in content:
    content = content.replace(target, replacement)
    with open('server/scripts/trigger.py', 'w') as f:
        f.write(content)
    print("Patched cwd successfully!")
else:
    print("Target not found.")
