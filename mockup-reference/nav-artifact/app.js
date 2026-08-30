/* TaskFlow · Navigation Preview · interactive layer */
(() => {
  'use strict';

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ----------------------------------------------------------
     1. Magnetic floating indicator (sidebar)
     ---------------------------------------------------------- */
  function setupMagneticIndicator(navEl, indicatorEl, itemSelector) {
    if (!navEl || !indicatorEl) return;
    const items = Array.from(navEl.querySelectorAll(itemSelector));
    if (!items.length) return;

    // Place indicator initially under active item
    const active = items.find((el) => el.classList.contains('is-active')) || items[0];
    requestAnimationFrame(() => {
      positionIndicator(active, indicatorEl, false);
      indicatorEl.classList.add('is-ready');
    });

    items.forEach((item) => {
      // Use 'pointerover' (bubbles) instead of 'mouseenter' (doesn't bubble) so
      // hovers over SVG/child elements still update the indicator.
      item.addEventListener('pointerover', () => positionIndicator(item, indicatorEl, true));
      item.addEventListener('focus', () => positionIndicator(item, indicatorEl, true));
    });

    navEl.addEventListener('mouseleave', () => {
      const current = items.find((el) => el.classList.contains('is-active')) || items[0];
      positionIndicator(current, indicatorEl, true);
    });
  }

  function positionIndicator(item, indicatorEl, animate = true) {
    if (!item) return;
    const navRect = item.parentElement.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const top = itemRect.top - navRect.top;
    const height = itemRect.height;

    if (!animate || prefersReducedMotion) {
      indicatorEl.style.transition = 'none';
    } else {
      indicatorEl.style.transition = '';
    }

    indicatorEl.style.transform = `translateY(${top}px)`;
    indicatorEl.style.height = `${height}px`;
  }

  /* ----------------------------------------------------------
     2. Switch active nav item
     ---------------------------------------------------------- */
  function setupNavSwitching(navEl, itemSelector, indicatorEl, onChange) {
    const items = navEl.querySelectorAll(itemSelector);
    items.forEach((item) => {
      item.addEventListener('click', (e) => {
        // Avoid navigation in demo
        e.preventDefault();

        items.forEach((el) => {
          el.classList.remove('is-active');
          el.setAttribute('aria-current', 'false');
        });
        item.classList.add('is-active');
        item.setAttribute('aria-current', 'page');

        // Move the magnetic indicator to the newly active item (animated)
        if (indicatorEl) positionIndicator(item, indicatorEl, true);

        // Ripple
        spawnRipple(item, e);

        // Press feedback
        item.classList.add('is-pressed');
        setTimeout(() => item.classList.remove('is-pressed'), 180);

        if (onChange) onChange(item);
      });
    });
  }

  /* ----------------------------------------------------------
     3. Ripple
     ---------------------------------------------------------- */
  function spawnRipple(target, evt) {
    const rect = target.getBoundingClientRect();
    const x = (evt && evt.clientX) ? evt.clientX - rect.left : rect.width / 2;
    const y = (evt && evt.clientY) ? evt.clientY - rect.top : rect.height / 2;
    const size = Math.max(rect.width, rect.height) * 1.6;

    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;

    target.appendChild(ripple);
    setTimeout(() => ripple.remove(), 720);
  }

  /* ----------------------------------------------------------
     4. Task check toggle
     ---------------------------------------------------------- */
  function setupTasks() {
    const list = document.getElementById('taskList');
    if (!list) return;

    list.addEventListener('click', (e) => {
      const check = e.target.closest('.task__check');
      if (!check) return;
      const task = check.closest('.task');
      const box = check.querySelector('.task__check-box');
      const title = task.querySelector('.task__title');
      const wasDone = task.classList.contains('is-done');

      if (wasDone) {
        task.classList.remove('is-done');
        box.classList.remove('is-checked');
        box.innerHTML = '';
        if (title) title.classList.remove('task__title--done');
      } else {
        task.classList.add('is-done');
        box.classList.add('is-checked');
        box.innerHTML = `
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>`;
        if (title) title.classList.add('task__title--done');
      }

      // Tiny haptic-like vibration
      if (navigator.vibrate) navigator.vibrate(8);
    });
  }

  /* ----------------------------------------------------------
     5. Animated KPI counter
     ---------------------------------------------------------- */
  function animateNumber(el, to, duration = 1100) {
    if (!el) return;
    const from = parseFloat(el.dataset.value || '0');
    const start = performance.now();
    const decimals = (el.dataset.decimals ? parseInt(el.dataset.decimals, 10) : 0);

    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      // ease-out-quart
      const eased = 1 - Math.pow(1 - t, 4);
      const value = from + (to - from) * eased;
      el.textContent = value.toFixed(decimals);
      if (t < 1) requestAnimationFrame(tick);
      else el.dataset.value = String(to);
    }
    requestAnimationFrame(tick);
  }

  /* ----------------------------------------------------------
     6. Recompute indicator on resize (sidebar nav height)
     ---------------------------------------------------------- */
  function setupResizeSync(navEl, indicatorEl, itemSelector) {
    let raf;
    window.addEventListener('resize', () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const active = navEl.querySelector(`${itemSelector}.is-active`) || navEl.querySelector(itemSelector);
        if (active) positionIndicator(active, indicatorEl, false);
      });
    });
  }

  /* ----------------------------------------------------------
     7. Sync topbar title with active section
     ---------------------------------------------------------- */
  function setupTitleSync(navEl, titleEl, dateEl, itemSelector) {
    navEl.addEventListener('click', (e) => {
      const item = e.target.closest(itemSelector);
      if (!item) return;
      const label = item.dataset.label;
      if (!label || !titleEl) return;
      titleEl.textContent = label;
      // Bounce
      titleEl.animate(
        [
          { transform: 'translateY(-4px)', opacity: 0.4 },
          { transform: 'translateY(0)', opacity: 1 }
        ],
        { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
      );
    });
  }

  /* ----------------------------------------------------------
     INIT
     ---------------------------------------------------------- */
  document.addEventListener('DOMContentLoaded', () => {
    /* Sidebar (desktop) */
    const sidebarNav = document.getElementById('sidebarNav');
    const sidebarIndicator = document.getElementById('navIndicator');
    const titleEl = document.querySelector('.content__title');

    setupMagneticIndicator(sidebarNav, sidebarIndicator, '.nav-item');
    setupNavSwitching(sidebarNav, '.nav-item', sidebarIndicator);
    setupResizeSync(sidebarNav, sidebarIndicator, '.nav-item');
    setupTitleSync(sidebarNav, titleEl, null, '.nav-item');

    /* Bottom nav (mobile) */
    const bottomNav = document.getElementById('bottomNav');
    const bottomIndicator = document.getElementById('bottomIndicator');
    setupMagneticIndicator(bottomNav, bottomIndicator, '.bottom-nav__item');
    setupNavSwitching(bottomNav, '.bottom-nav__item', bottomIndicator);
    setupResizeSync(bottomNav, bottomIndicator, '.bottom-nav__item');
    setupTitleSync(bottomNav, titleEl, null, '.bottom-nav__item');

    /* Tasks */
    setupTasks();

    /* KPI animate when visible */
    const kpiValue = document.querySelector('.kpi-card__value');
    if (kpiValue) animateNumber(kpiValue, 7, 900);

    /* Show active item label on first load (mobile) */
    const firstMobile = bottomNav.querySelector('.bottom-nav__item.is-active');
    if (firstMobile && titleEl && window.innerWidth <= 960) {
      titleEl.textContent = firstMobile.dataset.label || titleEl.textContent;
    }

    /* Keyboard navigation 1..5 for sidebar */
    document.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const items = sidebarNav ? Array.from(sidebarNav.querySelectorAll('.nav-item')) : [];
      if (!items.length) return;
      const currentIdx = items.findIndex((el) => el.classList.contains('is-active'));
      let next = null;
      if (e.key === 'ArrowDown' || e.key === 'j') next = items[Math.min(items.length - 1, currentIdx + 1)];
      else if (e.key === 'ArrowUp' || e.key === 'k') next = items[Math.max(0, currentIdx - 1)];
      else if (/^[1-5]$/.test(e.key)) next = items[parseInt(e.key, 10) - 1];
      if (next) {
        e.preventDefault();
        next.click();
        next.focus();
      }
    });
  });
})();
