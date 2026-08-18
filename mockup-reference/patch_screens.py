#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Add 5 new screens + navigation to todoist mockup."""
import io, sys

PATH = '/home/maksim/todoist-mockup/index.html'
src = io.open(PATH, encoding='utf-8').read()

def rep(old, new, label):
    global src
    n = src.count(old)
    assert n == 1, f'ANCHOR "{label}" found {n} times (expected 1)'
    src = src.replace(old, new)
    print(f'OK  {label}')

# ---------- 1. CSS ----------
css_anchor = '''  color:rgba(255,255,255,.35);
}
</style>'''
css_add = '''  color:rgba(255,255,255,.35);
}

/* ============ ЭКРАНЫ АВТОРИЗАЦИИ (логин / регистрация) ============ */
.auth-wrap{flex:1;display:flex;flex-direction:column;align-items:center;padding:44px 24px 24px;overflow-y:auto;scrollbar-width:none}
.auth-logo{width:72px;height:72px;border-radius:50%;background:var(--red);display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 12px 30px rgba(228,67,50,.38);flex-shrink:0}
.auth-logo svg{width:34px;height:34px}
.auth-app{font-size:28px;font-weight:800;letter-spacing:-.4px;margin-top:16px}
.auth-head{font-size:20px;font-weight:600;margin-top:24px;text-align:center}
.auth-sub{font-size:14px;color:var(--sub);margin-top:6px;text-align:center}
.auth-card{width:100%;margin-top:24px}
.field{display:flex;align-items:center;gap:11px;height:50px;padding:0 14px}
.field + .field{border-top:1px solid var(--stroke)}
.f-ic{color:var(--sub);display:flex;align-items:center}
.f-ph{flex:1;font-size:15px;color:var(--sub);text-align:left}
.f-eye{color:var(--dim);display:flex;align-items:center}
.auth-btn{width:100%;height:50px;border-radius:12px;background:var(--red);color:#fff;font-size:16px;font-weight:600;display:flex;align-items:center;justify-content:center;margin-top:16px;box-shadow:0 8px 20px rgba(228,67,50,.3)}
.auth-btn:active{opacity:.85}
.auth-divider{display:flex;align-items:center;gap:12px;width:100%;margin:22px 0;color:var(--dim);font-size:13px}
.auth-divider::before,.auth-divider::after{content:"";flex:1;height:1px;background:var(--stroke)}
.google-btn{width:100%;height:50px;border-radius:12px;background:#2B2B2B;border:1px solid rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center;gap:10px;font-size:15px;font-weight:600;color:var(--text)}
.google-btn:active{background:#333333}
.auth-foot{font-size:14px;color:var(--sub);margin-top:auto;padding-top:30px;text-align:center}
.auth-foot a{color:var(--red);font-weight:600;cursor:pointer}

.reg-role-label{width:100%;font-size:13px;font-weight:600;color:var(--sub);margin:20px 2px 8px}
.role-row{display:flex;gap:10px;width:100%}
.role-opt{flex:1;display:flex;align-items:center;justify-content:center;gap:7px;height:44px;border-radius:12px;background:var(--card);border:1.5px solid var(--stroke);font-size:13.5px;font-weight:600;color:var(--sub)}
.role-opt.sel{border-color:var(--red);color:var(--red);background:rgba(228,67,50,.07)}
.role-opt:active{opacity:.8}

/* ============ ЭКРАН «НОВАЯ ЗАДАЧА» ============ */
.nt-title{width:100%;background:none;border:none;outline:none;resize:none;font-family:inherit;font-size:20px;font-weight:600;color:var(--text);padding:16px 16px 2px;min-height:46px;display:block}
.nt-title::placeholder{color:#8A8A8A}
.nt-desc{width:100%;background:none;border:none;outline:none;resize:none;font-family:inherit;font-size:15px;color:var(--sub);padding:4px 16px 12px;min-height:42px;display:block}
.nt-desc::placeholder{color:var(--sub)}
.p1-pill{display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;background:var(--red);min-width:26px;height:20px;border-radius:10px;padding:0 7px;flex-shrink:0}
.badge-pill{display:inline-flex;align-items:center;font-size:10.5px;font-weight:600;padding:2.5px 8px;border-radius:9px;background:rgba(255,255,255,.09);color:var(--sub);flex-shrink:0}
.nt-add{border-top:1px dashed rgba(255,255,255,.14)!important}
.tags-row{display:flex;gap:8px;padding:13px 14px;overflow-x:auto;scrollbar-width:none}
.tag-pill-2{display:inline-flex;align-items:center;flex-shrink:0;font-size:12.5px;font-weight:600;color:var(--pink);background:rgba(255,122,138,.12);padding:6px 13px;border-radius:10px}
.tag-pill-2.plus{color:var(--sub);background:rgba(255,255,255,.08)}

/* ============ ЭКРАН «УВЕДОМЛЕНИЯ» ============ */
.notif-row{align-items:flex-start!important;min-height:0!important;padding:12px 14px!important;gap:12px}
.n-main{font-size:14px;font-weight:600;line-height:1.35;color:#ECECEC}
.n-sub{font-size:12px;color:var(--sub);margin-top:2px;line-height:1.35}
.n-time{font-size:12px;color:var(--dim);margin-top:4px}
.n-dot{width:8px;height:8px;border-radius:50%;background:var(--red);flex-shrink:0;margin-top:5px}

/* ============ ЭКРАН «АГЕНТЫ» ============ */
.ag-row{min-height:60px;padding:10px 14px}
.ag-status{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--sub);flex-shrink:0}
.ag-dot{width:7px;height:7px;border-radius:50%;background:#4CD964;flex-shrink:0}
.cap-tag{font-size:10.5px;font-weight:600;color:var(--sub);background:rgba(255,255,255,.07);padding:2px 8px;border-radius:8px}
.inv-card{background:none;border:1.5px dashed rgba(255,255,255,.16);border-radius:14px;margin:0 16px}
.inv-card .row{justify-content:center;gap:8px;min-height:52px}
.role-info{padding:2px 14px}
.ri-item{font-size:13px;color:var(--sub);line-height:1.5;padding:11px 0}
.ri-item + .ri-item{border-top:1px solid var(--stroke)}
.ri-item b{color:var(--text);font-weight:600}
</style>'''
rep(css_anchor, css_add, 'CSS block')

# ---------- 2. New screens HTML ----------
sb = '''      <div class="statusbar"><span class="sb-left">08:18</span>
        <span class="sb-right">
          <i class="ic" style="width:15px;height:15px" data-i="bellSlash"></i>
          <i class="ic" style="width:16px;height:13px" data-i="signal"></i>
          <i class="ic" style="width:16px;height:13px" data-i="wifi"></i>
          <i class="ic" style="width:28px;height:13px" data-i="battery"></i>
        </span>
      </div>'''

google_g = '''<span class="g"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"/><path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"/><path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"/><path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"/></svg></span>'''

login_screen = '''    <!-- ================= ЭКРАН 9 · ЛОГИН ================= -->
    <section class="screen" id="s-login">
''' + sb + '''

      <div class="auth-wrap">
        <div class="auth-logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
        </div>
        <div class="auth-app">Todoist</div>
        <div class="auth-head">Добро пожаловать!</div>
        <div class="auth-sub">Войдите в свой аккаунт</div>

        <div class="card auth-card">
          <div class="field">
            <span class="f-ic"><i class="ic" style="width:18px;height:18px" data-i="mail"></i></span>
            <span class="f-ph">Email</span>
          </div>
          <div class="field">
            <span class="f-ic"><i class="ic" style="width:18px;height:18px" data-i="lock"></i></span>
            <span class="f-ph">Пароль</span>
            <span class="f-eye"><i class="ic" style="width:17px;height:17px" data-i="eye"></i></span>
          </div>
        </div>

        <button class="auth-btn" id="btnLogin">Войти</button>

        <div class="auth-divider"><span>или</span></div>

        <button class="google-btn">''' + google_g + '''
          Войти через Google
        </button>

        <div class="auth-foot">Нет аккаунта? <a id="btnGoRegister">Зарегистрируйтесь</a></div>
      </div>
    </section>

    <!-- ================= ЭКРАН 10 · РЕГИСТРАЦИЯ ================= -->
    <section class="screen" id="s-register">
''' + sb + '''

      <div class="center-head">
        <div class="left-slot">
          <button class="pill-btn" id="btnRegBack"><i class="ic" style="width:17px;height:17px" data-i="chevL"></i></button>
        </div>
        <h2>Регистрация</h2>
      </div>

      <div class="auth-wrap" style="padding-top:22px">
        <div class="auth-head" style="margin-top:0">Создайте аккаунт</div>
        <div class="auth-sub">Присоединяйтесь к команде</div>

        <div class="card auth-card">
          <div class="field">
            <span class="f-ic"><i class="ic" style="width:18px;height:18px" data-i="person"></i></span>
            <span class="f-ph">Имя</span>
          </div>
          <div class="field">
            <span class="f-ic"><i class="ic" style="width:18px;height:18px" data-i="mail"></i></span>
            <span class="f-ph">Email</span>
          </div>
          <div class="field">
            <span class="f-ic"><i class="ic" style="width:18px;height:18px" data-i="lock"></i></span>
            <span class="f-ph">Пароль</span>
          </div>
          <div class="field">
            <span class="f-ic"><i class="ic" style="width:18px;height:18px" data-i="lock"></i></span>
            <span class="f-ph">Подтвердите пароль</span>
          </div>
        </div>

        <div class="reg-role-label">Роль в команде</div>
        <div class="role-row">
          <button class="role-opt sel" id="roleOwner"><span style="display:flex"><i class="ic" style="width:16px;height:16px" data-i="crown"></i></span>Владелец</button>
          <button class="role-opt" id="roleAgent"><span style="display:flex"><i class="ic" style="width:16px;height:16px" data-i="bot"></i></span>Агент</button>
        </div>

        <button class="auth-btn" id="btnRegisterDone">Создать аккаунт</button>

        <div class="auth-foot">Уже есть аккаунт? <a id="btnGoLogin">Войти</a></div>
      </div>
    </section>

    <!-- ================= ЭКРАН 11 · НОВАЯ ЗАДАЧА ================= -->
    <section class="screen" id="s-newtask">
''' + sb + '''

      <div class="center-head">
        <div class="left-slot">
          <button class="pill-btn" id="btnNewTaskClose" style="border-radius:50%"><i class="ic" style="width:15px;height:15px" data-i="x"></i></button>
        </div>
        <h2>Новая задача</h2>
        <div class="right-slot">
          <button id="btnNewTaskDone" style="font-size:16px;font-weight:600;color:var(--red)">Готово</button>
        </div>
      </div>

      <div class="scroll">
        <textarea class="nt-title" rows="1" placeholder="Название задачи"></textarea>
        <textarea class="nt-desc" rows="2" placeholder="Описание"></textarea>

        <div class="card" style="margin-top:4px">
          <button class="row">
            <span class="r-ic" style="color:var(--red)"><i class="ic" style="width:18px;height:18px" data-i="calMini"></i></span>
            <span class="r-tx">Срок</span>
            <span class="r-val" style="color:var(--red)">Завтра, 11 авг.</span>
            <span class="r-chev"><i class="ic" style="width:14px;height:14px" data-i="chevR"></i></span>
          </button>
          <button class="row">
            <span class="r-ic" style="color:var(--sub)"><i class="ic" style="width:18px;height:18px" data-i="hash"></i></span>
            <span class="r-tx">Проект</span>
            <span class="r-val">Входящие</span>
            <span class="r-chev"><i class="ic" style="width:14px;height:14px" data-i="chevR"></i></span>
          </button>
          <button class="row">
            <span class="r-ic" style="color:var(--sub)"><i class="ic" style="width:18px;height:18px" data-i="flag"></i></span>
            <span class="r-tx">Приоритет</span>
            <span class="p1-pill">P1</span>
            <span class="r-chev"><i class="ic" style="width:14px;height:14px" data-i="chevR"></i></span>
          </button>
        </div>

        <div class="sec-label">Назначить</div>
        <div class="card">
          <button class="row" style="min-height:52px">
            <span class="avatar" style="width:32px;height:32px;font-size:14px;background:var(--teal)">М</span>
            <span class="r-tx">Максим</span>
            <span class="badge-pill">Владелец</span>
            <span style="color:var(--red);display:flex;flex-shrink:0"><i class="ic" style="width:17px;height:17px" data-i="check"></i></span>
          </button>
          <button class="row" style="min-height:52px">
            <span class="avatar" style="width:32px;height:32px;font-size:14px;background:var(--purple)">C</span>
            <span class="r-tx">Claude_Bot</span>
            <span class="badge-pill">Агент</span>
            <span class="r-chev"><i class="ic" style="width:14px;height:14px" data-i="chevR"></i></span>
          </button>
          <button class="row" style="min-height:52px">
            <span class="avatar" style="width:32px;height:32px;font-size:14px;background:var(--orange)">H</span>
            <span class="r-tx">Hermes</span>
            <span class="badge-pill">Агент</span>
            <span class="r-chev"><i class="ic" style="width:14px;height:14px" data-i="chevR"></i></span>
          </button>
          <button class="row nt-add" style="min-height:48px">
            <span class="r-ic" style="color:var(--sub)"><i class="ic" style="width:16px;height:16px" data-i="plus"></i></span>
            <span class="r-tx" style="color:var(--sub);font-size:14px">Добавить агента</span>
          </button>
        </div>

        <div class="sec-label">Метки</div>
        <div class="card">
          <div class="tags-row">
            <span class="tag-pill-2">Ипотека</span>
            <span class="tag-pill-2">база-знаний</span>
            <span class="tag-pill-2 plus">+ новая</span>
          </div>
        </div>

        <div class="sec-label">Подзадачи</div>
        <div class="card">
          <button class="row" style="min-height:48px">
            <span class="circle c-gray" style="width:16px;height:16px;flex-shrink:0"></span>
            <span class="r-tx" style="color:var(--sub);font-size:14px">Добавить подзадачу...</span>
          </button>
        </div>
      </div>
    </section>

    <!-- ================= ЭКРАН 12 · УВЕДОМЛЕНИЯ ================= -->
    <section class="screen" id="s-notifications">
''' + sb + '''

      <div class="center-head">
        <div class="left-slot">
          <button class="pill-btn" id="btnNotifBack"><i class="ic" style="width:17px;height:17px" data-i="chevL"></i></button>
        </div>
        <h2>Уведомления</h2>
        <div class="right-slot">
          <button style="font-size:13px;color:var(--sub)">Прочитать все</button>
        </div>
      </div>

      <div class="scroll">
        <div class="card">
          <button class="row notif-row">
            <span class="avatar" style="width:36px;height:36px;font-size:15px;background:var(--purple)">C</span>
            <span style="flex:1;min-width:0;text-align:left">
              <div class="n-main">Claude_Bot назначен на задачу</div>
              <div class="n-sub">Судебное заседание</div>
              <div class="n-time">2 мин. назад</div>
            </span>
            <span class="n-dot"></span>
          </button>
          <button class="row notif-row">
            <span class="avatar" style="width:36px;height:36px;font-size:15px;background:var(--orange)">H</span>
            <span style="flex:1;min-width:0;text-align:left">
              <div class="n-main">Hermes завершил задачу</div>
              <div class="n-sub">Настройка ии</div>
              <div class="n-time">15 мин. назад</div>
            </span>
            <span class="n-dot"></span>
          </button>
          <button class="row notif-row">
            <span style="width:36px;height:36px;border-radius:50%;background:var(--card2);display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="ic" style="width:17px;height:17px" data-i="gear"></i></span>
            <span style="flex:1;min-width:0;text-align:left">
              <div class="n-main">Новая задача назначена вам</div>
              <div class="n-sub">Оплатить коммуналку</div>
              <div class="n-time">1 час назад</div>
            </span>
          </button>
          <button class="row notif-row">
            <span class="avatar" style="width:36px;height:36px;font-size:15px;background:var(--purple)">C</span>
            <span style="flex:1;min-width:0;text-align:left">
              <div class="n-main">Claude_Bot прокомментировал</div>
              <div class="n-sub">База знаний: единый источник...</div>
              <div class="n-time">2 часа назад</div>
            </span>
          </button>
          <button class="row notif-row">
            <span class="avatar" style="width:36px;height:36px;font-size:15px;background:var(--orange)">H</span>
            <span style="flex:1;min-width:0;text-align:left">
              <div class="n-main">Hermes создал подзадачу</div>
              <div class="n-sub">Выпустить ЭЦП → Получить ЭЦП в налоговой</div>
              <div class="n-time">Вчера</div>
            </span>
          </button>
        </div>
      </div>
    </section>

    <!-- ================= ЭКРАН 13 · АГЕНТЫ ================= -->
    <section class="screen" id="s-agents">
''' + sb + '''

      <div class="center-head">
        <div class="left-slot">
          <button class="pill-btn" id="btnAgentsBack"><i class="ic" style="width:17px;height:17px" data-i="chevL"></i></button>
        </div>
        <h2>Агенты</h2>
        <div class="right-slot">
          <button class="pill-btn"><i class="ic" style="width:16px;height:16px" data-i="plus"></i></button>
        </div>
      </div>

      <div class="scroll">
        <div class="sec-label">Команда</div>
        <div class="card">
          <div class="row ag-row">
            <span class="avatar" style="width:38px;height:38px;font-size:16px;background:var(--teal)">М</span>
            <span style="flex:1;min-width:0;text-align:left">
              <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:15px;font-weight:600">Максим</span>
                <span class="badge-pill" style="background:var(--red);color:#fff">Владелец</span>
              </div>
            </span>
            <span class="ag-status"><span class="ag-dot"></span>Онлайн</span>
          </div>
          <div class="row ag-row">
            <span class="avatar" style="width:38px;height:38px;font-size:16px;background:var(--purple)">C</span>
            <span style="flex:1;min-width:0;text-align:left">
              <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:15px;font-weight:600">Claude_Bot</span>
                <span class="badge-pill" style="background:var(--purple);color:#fff">Агент</span>
              </div>
              <div style="display:flex;gap:6px;margin-top:5px">
                <span class="cap-tag">Код</span>
                <span class="cap-tag">Ревью</span>
              </div>
            </span>
            <span class="ag-status"><span class="ag-dot"></span>Онлайн</span>
          </div>
          <div class="row ag-row">
            <span class="avatar" style="width:38px;height:38px;font-size:16px;background:var(--orange)">H</span>
            <span style="flex:1;min-width:0;text-align:left">
              <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:15px;font-weight:600">Hermes</span>
                <span class="badge-pill" style="background:var(--orange);color:#fff">Агент</span>
              </div>
              <div style="display:flex;gap:6px;margin-top:5px">
                <span class="cap-tag">DevOps</span>
                <span class="cap-tag">Инфра</span>
              </div>
            </span>
            <span class="ag-status"><span class="ag-dot"></span>Онлайн</span>
          </div>
        </div>

        <div class="sec-label">Приглашения</div>
        <div class="inv-card">
          <button class="row">
            <span class="r-ic" style="color:var(--sub)"><i class="ic" style="width:16px;height:16px" data-i="plus"></i></span>
            <span class="r-tx" style="color:var(--sub);font-size:14px">Пригласить агента</span>
          </button>
        </div>

        <div class="sec-label">Роль агента</div>
        <div class="card role-info">
          <div class="ri-item"><b>Владелец</b> — полный доступ ко всем задачам и настройкам</div>
          <div class="ri-item"><b>Агент</b> — может редактировать назначенные задачи, добавлять комментарии, отмечать выполнение</div>
          <div class="ri-item"><b>Наблюдатель</b> — только просмотр</div>
        </div>
      </div>
    </section>

    <!-- ================= МОДАЛКА 5 · ОТОБРАЖЕНИЕ ================= -->'''
rep('    <!-- ================= МОДАЛКА 5 · ОТОБРАЖЕНИЕ ================= -->', login_screen, '5 new screens HTML')

# ---------- 3. Bell id on overview ----------
rep(
'''<button class="round-btn" style="width:38px;height:38px"><i class="ic" style="width:17px;height:17px" data-i="bell"></i></button>''',
'''<button class="round-btn" id="btnBell" style="width:38px;height:38px"><i class="ic" style="width:17px;height:17px" data-i="bell"></i></button>''',
'bell id')

# ---------- 4. Settings -> Agents row ----------
rep(
'''<button class="row"><span class="r-ic"><i class="ic" style="width:20px;height:20px" data-i="person"></i></span><span class="r-tx">Аккаунт</span><span class="r-chev"><i class="ic" style="width:14px;height:14px" data-i="chevR"></i></span></button>''',
'''<button class="row"><span class="r-ic"><i class="ic" style="width:20px;height:20px" data-i="person"></i></span><span class="r-tx">Аккаунт</span><span class="r-chev"><i class="ic" style="width:14px;height:14px" data-i="chevR"></i></span></button>
          <button class="row" id="btnOpenAgents"><span class="r-ic" style="color:var(--purple)"><i class="ic" style="width:20px;height:20px" data-i="bot"></i></span><span class="r-tx">Агенты</span><span class="r-chev"><i class="ic" style="width:14px;height:14px" data-i="chevR"></i></span></button>''',
'settings agents row')

# ---------- 5. Panel buttons 9-13 ----------
rep(
'''<button class="pnl-btn" data-go="inbox"><span class="n">8</span>Входящие</button>''',
'''<button class="pnl-btn" data-go="inbox"><span class="n">8</span>Входящие</button>
  <button class="pnl-btn" data-go="login"><span class="n">9</span>Логин</button>
  <button class="pnl-btn" data-go="register"><span class="n">10</span>Регистрация</button>
  <button class="pnl-btn" data-go="newtask"><span class="n">11</span>Новая задача</button>
  <button class="pnl-btn" data-go="notifications"><span class="n">12</span>Уведомления</button>
  <button class="pnl-btn" data-go="agents"><span class="n">13</span>Агенты</button>''',
'panel buttons')

# ---------- 6. New icons ----------
rep(
'''stroke-linejoin="round"><path d="M8 4v13M8 17l-3.5-3.5M8 17l3.5-3.5"/><path d="M16 20V7M16 7l-3.5 3.5M16 7l3.5 3.5"/></svg>'
};''',
'''stroke-linejoin="round"><path d="M8 4v13M8 17l-3.5-3.5M8 17l3.5-3.5"/><path d="M16 20V7M16 7l-3.5 3.5M16 7l3.5 3.5"/></svg>',
  chevL:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  mail:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/></svg>',
  eye:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/></svg>',
  crown:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5l4.4 3.4L12 5.5l3.6 6.4L20 8.5l-1.5 9H5.5z"/><path d="M5.5 20.5h13"/></svg>',
  bot:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8.5" width="16" height="10.5" rx="2.5"/><path d="M12 8.5V5M12 5l-2-2M12 5l2-2"/><circle cx="9" cy="13.2" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="13.2" r="1.2" fill="currentColor" stroke="none"/><path d="M9.5 16.4h5"/></svg>'
};''',
'ICONS additions')

# ---------- 7. screens array ----------
rep(
"const screens=['overview','settings2','settings','upcoming','today','inbox'];",
"const screens=['overview','settings2','settings','upcoming','today','inbox','login','register','newtask','notifications','agents'];",
'screens array')

# ---------- 8. JS wiring ----------
rep(
"document.getElementById('btnViewOptions').addEventListener('click',openModal);",
'''document.getElementById('btnViewOptions').addEventListener('click',openModal);

/* новые экраны: авторизация, новая задача, уведомления, агенты */
document.getElementById('btnLogin').addEventListener('click',()=>show('overview'));
document.getElementById('btnGoRegister').addEventListener('click',()=>show('register'));
document.getElementById('btnGoLogin').addEventListener('click',()=>show('login'));
document.getElementById('btnRegBack').addEventListener('click',()=>show('login'));
document.getElementById('btnRegisterDone').addEventListener('click',()=>show('login'));
document.querySelectorAll('.role-opt').forEach(r=>r.addEventListener('click',()=>{
  document.querySelectorAll('.role-opt').forEach(x=>x.classList.remove('sel'));
  r.classList.add('sel');
}));
document.getElementById('btnNewTaskDone').addEventListener('click',()=>show('inbox'));
document.getElementById('btnNewTaskClose').addEventListener('click',()=>show('inbox'));
document.getElementById('btnNotifBack').addEventListener('click',()=>show('overview'));
document.getElementById('btnAgentsBack').addEventListener('click',()=>show('settings'));
document.getElementById('btnOpenAgents').addEventListener('click',()=>show('agents'));
document.getElementById('btnBell').addEventListener('click',()=>show('notifications'));
document.querySelectorAll('.fab:not(.fab-q)').forEach(f=>f.addEventListener('click',()=>show('newtask')));''',
'JS wiring')

io.open(PATH, 'w', encoding='utf-8').write(src)
print('\nDONE, new size:', len(src.encode('utf-8')), 'bytes')
