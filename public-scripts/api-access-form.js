/* =========================================================================
   ShieldTX — API access request form behavior

   Sibling of request-access-form.js. Same step engine (step navigation,
   brand dropdowns, per-field validation) but with its own payload and
   endpoint (/api/api-access), plus:
   - conditional questions (data-conditional wrappers shown/hidden by a
     controlling <select> via data-show-when="value1|value2")
   - the tailored-integration panel (data-tailored) with two actions:
     book a call (mailto) or continue submitting.

   Field/structure contract expected by this module:
   - <form data-state="idle" data-endpoint="/api/api-access">
   - <section class="waitlist-step is-active" data-step="1|2|3|result">
   - [data-dropdown] wrappers around hidden <select> + trigger + panel
   - [data-waitlist-back], [data-waitlist-next], [data-waitlist-submit],
     [data-waitlist-done], [data-waitlist-progress]
   - Conditional wrapper: <div class="waitlist-question is-conditional"
     data-conditional data-show-when="venueCoverage=valueA|valueB">
     whose controlling select is [data-controls="thatWrapperName"]… we use
     a simpler wiring: each conditional wrapper carries data-show-when
     "<selectName>=<v1>|<v2>" and the module resolves it by name.
   ========================================================================= */

(function () {
  'use strict';

  const ShieldTX = (window.ShieldTX = window.ShieldTX || {});

  ShieldTX.bindApiAccessForm = function bindApiAccessForm(formEl) {
    const form = typeof formEl === 'string' ? document.querySelector(formEl) : formEl;
    if (!form || form.dataset.boundApiAccess === '1') return null;
    form.dataset.boundApiAccess = '1';

    const root = form.closest('.waitlist-mount') || form.parentElement || form;
    const steps = Array.from(form.querySelectorAll('.waitlist-step'));
    const progressFill = root.querySelector('[data-waitlist-progress]');
    const backBtn = form.querySelector('[data-waitlist-back]');
    const nextBtn = form.querySelector('[data-waitlist-next]');
    const submitBtn = form.querySelector('[data-waitlist-submit]');
    const doneBtn = form.querySelector('[data-waitlist-done]');
    const errorEl = form.querySelector('[data-form-error]');
    const questionSteps = steps.filter((s) => s.dataset.step !== 'result');
    let idx = Math.max(0, steps.findIndex((s) => s.classList.contains('is-active')));
    let syncingConditionals = false;

    form.querySelectorAll('[data-dropdown]').forEach(initDropdown);

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    function fieldContainers(step) {
      return Array.from(step.querySelectorAll('.waitlist-field, .waitlist-question'))
        .filter((c) => !(c.classList.contains('is-conditional') && c.hidden));
    }

    function containerValid(container) {
      const email = container.querySelector('input[type="email"]');
      if (email) return EMAIL_RE.test(email.value.trim());
      const select = container.querySelector('select');
      if (select) {
        if (select.multiple) return Array.from(select.selectedOptions).some((o) => o.value);
        return !!select.value;
      }
      return true;
    }

    function stepValid() {
      const step = steps[idx];
      if (!step) return false;
      return fieldContainers(step).every(containerValid);
    }

    function errorMessageFor(container) {
      if (container.querySelector('input[type="email"]')) return 'Enter a valid email address.';
      const select = container.querySelector('select');
      if (select && select.multiple) return 'Select at least one option.';
      return 'Please select an option.';
    }

    function fieldError(container, create) {
      const existing = container.nextElementSibling;
      if (existing && existing.classList && existing.classList.contains('waitlist-inline-error')) {
        return existing;
      }
      if (!create) return null;
      const el = document.createElement('p');
      el.className = 'waitlist-inline-error';
      el.setAttribute('role', 'alert');
      container.insertAdjacentElement('afterend', el);
      return el;
    }

    function showFieldError(container) {
      container.classList.add('is-invalid');
      fieldError(container, true).textContent = errorMessageFor(container);
    }

    function clearFieldError(container) {
      container.classList.remove('is-invalid');
      const el = fieldError(container, false);
      if (el) el.remove();
    }

    function clearIfValid(target) {
      if (!target || !target.closest) return;
      const container = target.closest('.waitlist-field, .waitlist-question');
      if (container && containerValid(container)) clearFieldError(container);
    }

    function revealStepErrors() {
      const step = steps[idx];
      let firstInvalid = null;
      fieldContainers(step).forEach((c) => {
        if (containerValid(c)) {
          clearFieldError(c);
        } else {
          showFieldError(c);
          if (!firstInvalid) firstInvalid = c;
        }
      });
      if (firstInvalid) {
        const focusable = firstInvalid.querySelector('input, [data-dropdown-trigger]');
        if (focusable) focusable.focus();
        firstInvalid.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return false;
      }
      return true;
    }

    function updateChrome() {
      const isResult = steps[idx].dataset.step === 'result';
      const isLastQ = idx === questionSteps.length - 1;
      if (progressFill) {
        progressFill.style.width = isResult ? '100%' : `${((idx + 1) / questionSteps.length) * 100}%`;
      }
      if (backBtn) backBtn.hidden = idx === 0 || isResult;
      if (nextBtn) nextBtn.hidden = isLastQ || isResult;
      if (submitBtn) submitBtn.hidden = !isLastQ || isResult;
      if (doneBtn) doneBtn.hidden = !isResult;
      if (nextBtn) nextBtn.disabled = false;
      if (submitBtn) submitBtn.disabled = form.dataset.state === 'submitting';
    }

    function goTo(target) {
      steps[idx].classList.remove('is-active');
      idx = target;
      steps[idx].classList.add('is-active');
      updateChrome();
      const focusable = steps[idx].querySelector('input, button[data-dropdown-trigger]');
      if (focusable) setTimeout(() => focusable.focus(), 60);
    }

    // ---- Conditional questions --------------------------------------
    // Wrapper: data-conditional + data-show-when="selectName=v1|v2" plus an
    // optional data-not-when="v3|v4" exclusion list. data-show-when with an
    // empty value list ("selectName=") means "any non-empty value".
    const conditionals = Array.from(form.querySelectorAll('[data-conditional]')).map((el) => {
      const expr = el.dataset.showWhen || '';
      const [selectName, rawValues] = expr.split('=');
      return {
        el,
        selectName: selectName || '',
        values: rawValues ? rawValues.split('|') : [],
        notValues: (el.dataset.notWhen || '').split('|').filter(Boolean),
      };
    });

    function syncConditionals() {
      if (syncingConditionals) return;
      syncingConditionals = true;
      try {
        conditionals.forEach(({ el, selectName, values, notValues }) => {
          const sel = form.querySelector(`select[name="${selectName}"]`);
          const show = !!sel && values.includes(sel.value) && !notValues.includes(sel.value);
          const wasHidden = el.hidden;
          el.hidden = !show;
          // Reset the conditional's own selects only when it transitions
          // from visible → hidden, so a stale multi-select never leaks into
          // the payload. Never dispatch 'change' here — the form-level
          // change listener re-enters this function and would recurse.
          if (!wasHidden && !show) {
            el.querySelectorAll('select').forEach((s) => {
              Array.from(s.options).forEach((o) => { o.selected = false; });
              syncSelectUI(s);
            });
            clearFieldError(el);
          }
        });
      } finally {
        syncingConditionals = false;
      }
      updateChrome();
    }

    // Refresh a select's custom dropdown UI after a programmatic change,
    // without going through the change event (which re-enters conditionals).
    function syncSelectUI(select) {
      const root = select.closest('[data-dropdown]');
      if (!root) return;
      const labelEl = root.querySelector('.waitlist-dropdown-label');
      const panel = root.querySelector('[data-dropdown-panel]');
      if (!labelEl || !panel) return;
      const placeholder = labelEl.dataset.placeholder || (labelEl.dataset.placeholder = labelEl.textContent);
      const picked = Array.from(select.selectedOptions);
      if (select.multiple) {
        if (picked.length === 0) {
          labelEl.textContent = placeholder;
          labelEl.classList.add('is-placeholder');
        } else if (picked.length === 1) {
          labelEl.textContent = picked[0].textContent;
          labelEl.classList.remove('is-placeholder');
        } else {
          labelEl.textContent = `${picked.length} Selected`;
          labelEl.classList.remove('is-placeholder');
        }
      }
      panel.querySelectorAll('.waitlist-dropdown-row').forEach((row) => {
        const opt = Array.from(select.options).find((o) => o.value === row.dataset.value);
        const isSel = !!opt && opt.selected;
        row.classList.toggle('is-selected', isSel);
        row.setAttribute('aria-selected', isSel ? 'true' : 'false');
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        if (!revealStepErrors()) return;
        if (idx >= questionSteps.length - 1) return;
        goTo(idx + 1);
      });
    }
    if (backBtn) {
      backBtn.addEventListener('click', () => { if (idx > 0) goTo(idx - 1); });
    }

    form.addEventListener('input', (e) => { clearIfValid(e.target); });
    form.addEventListener('change', (e) => { clearIfValid(e.target); syncConditionals(); });
    form.addEventListener('reset', () => {
      setTimeout(() => {
        steps.forEach((s) => s.classList.remove('is-active'));
        form.querySelectorAll('.waitlist-field.is-invalid, .waitlist-question.is-invalid').forEach(clearFieldError);
        conditionals.forEach(({ el }) => { el.hidden = true; });
        idx = 0;
        steps[0].classList.add('is-active');
        setState('idle');
        showError('');
        updateChrome();
      }, 0);
    });

    // ---- Book-a-call via walkthrough select --------------------------
    // Selecting "Yes — book a 20-minute call" opens a pre-filled mailto.
    const walkthroughSel = form.querySelector('select[name="walkthrough"]');
    if (walkthroughSel) {
      walkthroughSel.addEventListener('change', () => {
        if (walkthroughSel.value !== 'yes-call') return;
        const email = (form.querySelector('input[name="email"]') || {}).value || '';
        const subject = encodeURIComponent('ShieldTX API — tailored integration call');
        const body = encodeURIComponent(
          'Hi ShieldTX team,\n\n' +
          'I submitted an API access request and would like to walk you through our custody and execution requirements.\n\n' +
          `Email: ${email}\n\nThanks!`
        );
        window.location.href = `mailto:shieldtx-support@availproject.org?subject=${subject}&body=${body}`;
      });
    }

    // ---- Submit ------------------------------------------------------
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (form.dataset.state === 'submitting') return;
      if (!revealStepErrors()) return;
      if (idx < questionSteps.length - 1) { goTo(idx + 1); return; }

      const data = new FormData(form);
      const payload = {
        email: (data.get('email') || '').toString().trim(),
        use_case: data.get('use_case') || null,
        venue_coverage: data.get('venue_coverage') || null,
        other_venues: data.getAll('other_venues'),
        setup: data.get('setup') || null,
        walkthrough: data.get('walkthrough') || null,
      };

      setState('submitting');
      showError('');

      try {
        const res = await fetch(form.dataset.endpoint || '/api/api-access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const json = await res.json().catch(() => ({}));
        if (res.ok && json.ok) {
          setState('success');
          const resultIdx = steps.findIndex((s) => s.dataset.step === 'result');
          if (resultIdx > -1) goTo(resultIdx);
        } else {
          setState('idle');
          showError(json.error || 'Submission failed. Please try again.');
        }
      } catch (err) {
        console.error('[api-access] network error', err);
        setState('idle');
        showError('Network error. Please try again.');
      }
    });

    if (doneBtn) {
      doneBtn.addEventListener('click', () => {
        window.location.assign('/');
      });
    }

    function setState(state) {
      form.dataset.state = state;
      if (submitBtn) {
        submitBtn.disabled = state === 'submitting';
        submitBtn.classList.toggle('is-loading', state === 'submitting');
      }
    }

    function showError(msg) {
      if (!errorEl) return;
      if (msg) {
        errorEl.textContent = msg;
        errorEl.hidden = false;
      } else {
        errorEl.textContent = '';
        errorEl.hidden = true;
      }
    }

    syncConditionals();
    updateChrome();
    return { reset: () => form.reset() };
  };

  // Brand dropdown — same component as request-access-form.js.
  function initDropdown(root) {
    if (root.dataset.boundDropdown === '1') return;
    root.dataset.boundDropdown = '1';

    const select = root.querySelector('.waitlist-dropdown-native');
    const trigger = root.querySelector('[data-dropdown-trigger]');
    const labelEl = trigger && trigger.querySelector('.waitlist-dropdown-label');
    const panel = root.querySelector('[data-dropdown-panel]');
    if (!select || !trigger || !panel || !labelEl) return;

    const multi = select.multiple;
    const placeholder = labelEl.textContent;
    root.classList.add(multi ? 'is-multi' : 'is-single');

    while (panel.firstChild) panel.removeChild(panel.firstChild);
    const opts = Array.from(select.options).filter((o) => !o.disabled);
    opts.forEach((opt) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'waitlist-dropdown-row';
      row.setAttribute('role', 'option');
      row.dataset.value = opt.value;
      if (multi) {
        const check = document.createElement('span');
        check.className = 'waitlist-dropdown-check';
        check.setAttribute('aria-hidden', 'true');
        row.appendChild(check);
      }
      const lbl = document.createElement('span');
      lbl.className = 'waitlist-dropdown-row-label';
      lbl.textContent = opt.textContent;
      row.appendChild(lbl);
      panel.appendChild(row);
    });

    const syncFromSelect = () => {
      if (multi) {
        const picked = Array.from(select.selectedOptions);
        if (picked.length === 0) {
          labelEl.textContent = placeholder;
          labelEl.classList.add('is-placeholder');
        } else if (picked.length === 1) {
          labelEl.textContent = picked[0].textContent;
          labelEl.classList.remove('is-placeholder');
        } else {
          labelEl.textContent = `${picked.length} Selected`;
          labelEl.classList.remove('is-placeholder');
        }
      } else {
        const v = select.value;
        if (!v) {
          labelEl.textContent = placeholder;
          labelEl.classList.add('is-placeholder');
        } else {
          labelEl.textContent = select.options[select.selectedIndex].textContent;
          labelEl.classList.remove('is-placeholder');
        }
      }
      panel.querySelectorAll('.waitlist-dropdown-row').forEach((row) => {
        const opt = Array.from(select.options).find((o) => o.value === row.dataset.value);
        const isSel = !!opt && opt.selected;
        row.classList.toggle('is-selected', isSel);
        row.setAttribute('aria-selected', isSel ? 'true' : 'false');
      });
    };

    const closeAll = () => {
      document.querySelectorAll('[data-dropdown]').forEach((d) => {
        const p = d.querySelector('[data-dropdown-panel]');
        const t = d.querySelector('[data-dropdown-trigger]');
        if (p && !p.hidden) p.hidden = true;
        if (t) t.setAttribute('aria-expanded', 'false');
        d.classList.remove('is-open');
      });
    };
    const openThis = () => {
      closeAll();
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      root.classList.add('is-open');
    };

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (panel.hidden) openThis(); else closeAll();
    });

    panel.addEventListener('click', (e) => {
      const row = e.target.closest('.waitlist-dropdown-row');
      if (!row) return;
      e.preventDefault();
      const opt = Array.from(select.options).find((o) => o.value === row.dataset.value);
      if (!opt) return;
      if (multi) opt.selected = !opt.selected;
      else Array.from(select.options).forEach((o) => { o.selected = (o === opt); });
      select.dispatchEvent(new Event('change', { bubbles: true }));
      syncFromSelect();
      if (!multi) closeAll();
    });

    document.addEventListener('click', (e) => {
      if (!root.contains(e.target) && !panel.hidden) closeAll();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) closeAll();
    });

    if (select.form) {
      select.form.addEventListener('reset', () => setTimeout(syncFromSelect, 0));
    }

    syncFromSelect();
  }
})();