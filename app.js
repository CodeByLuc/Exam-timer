(() => {
  'use strict';

  const KEY = 'exam-timer-v1';
  const WARN_MS = 5 * 60 * 1000; // orange warning when 5 min are left
  const $ = (id) => document.getElementById(id);

  // ---------- state ----------
  // All times are in ms. Time is measured with timestamps, so it stays
  // correct when the tab is in the background or the page is reloaded.
  function freshState(totalMin, count, sound) {
    return {
      totalMs: totalMin * 60000,
      started: false,
      running: false,
      segStart: 0,   // timestamp when the current running segment began
      elapsed: 0,    // exam time used before the current segment
      active: 0,     // index of the challenge being worked on
      timeUp: false,
      sound: sound !== false,
      challenges: Array.from({ length: count }, (_, i) => ({
        name: `Challenge ${i + 1}`,
        spent: 0,     // time spent before the current segment
        done: false,
        budget: 0,    // budget it had when it was finished
        bonus: 0,     // time given to (or taken from) each remaining challenge
        warned: false,
        alerted: false,
      })),
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage blocked */ }
  }

  let s = load() || freshState(300, 7);
  let undoState = null;
  let toastTimer = null;

  // ---------- time math ----------
  function runningDelta(now) {
    if (!s.running) return 0;
    return Math.max(0, Math.min(now - s.segStart, s.totalMs - s.elapsed));
  }

  // Move the time of the current running segment into the stored totals.
  function commit(now) {
    const d = runningDelta(now);
    s.elapsed += d;
    if (s.active != null) s.challenges[s.active].spent += d;
    s.segStart = now;
  }

  // The fair share: everything not yet used by finished challenges
  // (remaining exam time + time already sunk into unfinished ones),
  // split equally between all unfinished challenges.
  // Finishing early grows the share of the others; finishing late shrinks it.
  function view(now) {
    const d = runningDelta(now);
    const elapsed = s.elapsed + d;
    const remaining = s.totalMs - elapsed;
    const spent = s.challenges.map((c, i) => c.spent + (i === s.active ? d : 0));
    const open = [];
    s.challenges.forEach((c, i) => { if (!c.done) open.push(i); });
    const pool = remaining + open.reduce((sum, i) => sum + spent[i], 0);
    const share = open.length ? pool / open.length : 0;
    return { elapsed, remaining, spent, open, pool, share };
  }

  function nextOpen(from) {
    const n = s.challenges.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + k + n) % n;
      if (!s.challenges[i].done) return i;
    }
    return null;
  }

  // ---------- formatting ----------
  function fmt(ms, forceHours) {
    const neg = ms < 0;
    const total = Math.floor(Math.abs(ms) / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const mm = String(m).padStart(h || forceHours ? 2 : 1, '0');
    const ss = String(sec).padStart(2, '0');
    const out = h || forceHours ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    return neg ? `-${out}` : out;
  }

  function signed(ms) {
    return (ms >= 0 ? '+' : '−') + fmt(Math.abs(ms));
  }

  // ---------- sound ----------
  let audio = null;
  function unlockAudio() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch { audio = null; }
  }

  function beep(times, freq) {
    if (!s.sound || !audio) return;
    try {
      for (let k = 0; k < times; k++) {
        const t = audio.currentTime + k * 0.35;
        const o = audio.createOscillator();
        const g = audio.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        o.connect(g).connect(audio.destination);
        o.start(t);
        o.stop(t + 0.32);
      }
    } catch { /* ignore */ }
  }

  // ---------- actions ----------
  function startPause() {
    const now = Date.now();
    unlockAudio();
    if (s.running) {
      commit(now);
      s.running = false;
    } else {
      if (s.timeUp || s.active == null) return;
      s.started = true;
      s.running = true;
      s.segStart = now;
    }
    save();
    render();
  }

  function finish() {
    if (!s.started || s.active == null) return;
    const now = Date.now();
    undoState = JSON.stringify(s);
    commit(now);

    const v = view(now);
    const idx = s.active;
    const c = s.challenges[idx];
    const others = v.open.length - 1;
    const saved = v.share - c.spent;

    c.done = true;
    c.budget = v.share;
    c.bonus = others > 0 ? saved / others : 0;
    s.active = nextOpen(idx);
    if (s.active == null) s.running = false;
    save();

    let msg;
    if (others === 0) {
      msg = `All challenges done! ${fmt(v.remaining, true)} of exam time to spare.`;
    } else {
      const newShare = (v.pool - c.spent) / others;
      const head = saved >= 0
        ? `${c.name} done in ${fmt(c.spent)} — ${fmt(saved)} saved.`
        : `${c.name} took ${fmt(c.spent)} — ${fmt(-saved)} over budget.`;
      msg = `${head} Each of the ${others} remaining challenges now gets ${fmt(newShare)} (${signed(c.bonus)}).`;
    }
    showToast(msg, true);
    render();
  }

  function switchTo(i) {
    if (i === s.active || s.challenges[i].done) return;
    commit(Date.now());
    s.active = i;
    save();
    render();
  }

  function undo() {
    if (!undoState) return;
    s = JSON.parse(undoState);
    undoState = null;
    save();
    hideToast();
    render();
  }

  function reset() {
    if (s.started && !confirm('Reset the whole exam timer? All progress will be lost.')) return;
    s = freshState(s.totalMs / 60000, s.challenges.length, s.sound);
    undoState = null;
    hideToast();
    save();
    buildList();
    render();
  }

  function applySetup() {
    if (s.started) return;
    const total = Math.min(1440, Math.max(1, Number($('totalInput').value) || 300));
    const count = Math.min(30, Math.max(1, Math.round(Number($('countInput').value)) || 7));
    s = freshState(total, count, s.sound);
    save();
    buildList();
    render();
  }

  // ---------- toast ----------
  function showToast(msg, canUndo) {
    $('toastMsg').textContent = msg;
    $('undoBtn').hidden = !canUndo;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 20000);
  }

  function hideToast() {
    $('toast').hidden = true;
    undoState = null;
  }

  // ---------- rendering ----------
  const list = $('list');
  const switcher = $('switcher');

  function buildList() {
    list.innerHTML = '';
    s.challenges.forEach((c, i) => {
      const li = document.createElement('li');
      li.className = 'item';
      li.dataset.i = i;
      li.innerHTML = '<span class="num"></span><span class="name"></span><span class="meta"></span>';
      li.querySelector('.num').textContent = i + 1;
      li.querySelector('.name').textContent = c.name;
      list.appendChild(li);
    });
  }

  function setMeta(el, main, sub, subClass) {
    el.textContent = main;
    if (sub) {
      const span = document.createElement('span');
      span.className = 'sub' + (subClass ? ' ' + subClass : '');
      span.textContent = sub;
      el.appendChild(span);
    }
  }

  function render() {
    const now = Date.now();

    // exam time ran out
    if (s.running && s.elapsed + (now - s.segStart) >= s.totalMs) {
      commit(now);
      s.running = false;
      s.timeUp = true;
      save();
      beep(5, 660);
      showToast('Exam time is over.', false);
    }

    const v = view(now);
    const n = s.challenges.length;
    const doneCount = n - v.open.length;

    // setup
    $('setup').hidden = s.started;
    if (!s.started) {
      if (document.activeElement !== $('totalInput')) $('totalInput').value = s.totalMs / 60000;
      if (document.activeElement !== $('countInput')) $('countInput').value = n;
      $('setupHint').textContent = `${n} challenges × ${fmt(s.totalMs / n)} each to start with.`;
    }

    // exam card
    $('examLeft').textContent = fmt(v.remaining, true);
    $('examBar').style.width = `${(v.elapsed / s.totalMs) * 100}%`;
    $('examElapsed').textContent = `${fmt(v.elapsed, true)} elapsed`;
    $('examDone').textContent = `${doneCount} / ${n} done`;
    const startBtn = $('startBtn');
    startBtn.textContent = !s.started ? 'Start exam' : s.running ? 'Pause' : 'Resume';
    startBtn.disabled = s.timeUp || s.active == null;
    $('soundBtn').textContent = `Sound: ${s.sound ? 'on' : 'off'}`;

    // current challenge card
    const cur = $('current');
    const a = s.active;
    if (a == null) {
      cur.classList.remove('warn', 'over');
      $('curName').textContent = 'Finished';
      $('curLeft').textContent = 'All done';
      $('curBar').style.width = '100%';
      $('curSpent').textContent = `${fmt(v.elapsed, true)} used`;
      $('curBudget').textContent = `${fmt(v.remaining, true)} spare`;
      $('finishBtn').disabled = true;
      $('projection').textContent = '';
      document.title = 'Exam Timer — done';
    } else {
      const c = s.challenges[a];
      const spent = v.spent[a];
      const left = v.share - spent;

      $('curName').textContent = s.timeUp ? `${c.name} — time is up` : `Now: ${c.name}`;
      $('curLeft').textContent = left >= 0 ? fmt(left) : `+${fmt(-left)}`;
      $('curBar').style.width = `${v.share > 0 ? Math.min(100, (spent / v.share) * 100) : 100}%`;
      $('curSpent').textContent = `spent ${fmt(spent)}`;
      $('curBudget').textContent = left >= 0 ? `budget ${fmt(v.share)}` : `budget ${fmt(v.share)} — over!`;
      cur.classList.toggle('over', left < 0);
      cur.classList.toggle('warn', left >= 0 && left < WARN_MS);
      $('finishBtn').disabled = !s.started;

      const others = v.open.length - 1;
      if (!s.started) {
        $('projection').textContent = 'Finish a challenge early and the saved time is split across the rest.';
      } else if (others > 0) {
        const proj = (v.pool - spent) / others;
        $('projection').textContent =
          `Finish now → each of the ${others} other challenges gets ${fmt(proj)} (${signed(proj - v.share)})`;
      } else {
        $('projection').textContent = 'Last challenge — all remaining time is yours.';
      }

      // alerts
      if (s.running) {
        if (!c.warned && left < WARN_MS && left > 0) {
          c.warned = true; save(); beep(1, 880);
        }
        if (!c.alerted && left <= 0) {
          c.alerted = true; save(); beep(3, 990);
          cur.classList.remove('flash'); void cur.offsetWidth; cur.classList.add('flash');
        }
      }

      document.title = s.running
        ? `${left >= 0 ? fmt(left) : '+' + fmt(-left)} · ${c.name}`
        : 'Exam Timer';
    }

    // switch buttons (one per unfinished challenge that isn't active)
    const others = v.open.filter((i) => i !== a);
    $('switchBox').hidden = others.length === 0 || s.timeUp;
    const key = others.join(',');
    if (switcher.dataset.key !== key) {
      switcher.dataset.key = key;
      switcher.innerHTML = '';
      others.forEach((i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.i = i;
        b.title = `Switch to ${s.challenges[i].name}`;
        b.innerHTML = '<span class="n"></span><span class="sub"></span>';
        b.querySelector('.n').textContent = i + 1;
        switcher.appendChild(b);
      });
    }
    [...switcher.children].forEach((b) => {
      const i = Number(b.dataset.i);
      b.querySelector('.sub').textContent = fmt(v.share - v.spent[i]);
    });

    // list
    if (list.children.length !== n) buildList();
    s.challenges.forEach((c, i) => {
      const li = list.children[i];
      const meta = li.querySelector('.meta');
      li.classList.toggle('active', i === a);
      li.classList.toggle('done', c.done);
      li.classList.toggle('late', c.done && c.spent > c.budget);

      if (c.done) {
        const diff = c.budget - c.spent;
        const isLast = c.bonus === 0;
        const sub = diff >= 0
          ? `saved ${fmt(diff)}${isLast ? '' : ` · ${signed(c.bonus)} each`}`
          : `${fmt(-diff)} over${isLast ? '' : ` · ${signed(c.bonus)} each`}`;
        setMeta(meta, `${fmt(c.spent)} used`, sub, diff >= 0 ? 'pos' : 'neg');
      } else if (i === a) {
        const left = v.share - v.spent[i];
        setMeta(meta, left >= 0 ? `${fmt(left)} left` : `+${fmt(-left)} over`, `budget ${fmt(v.share)}`);
      } else if (v.spent[i] >= 1000) {
        setMeta(meta, `${fmt(v.share - v.spent[i])} left`, `paused · ${fmt(v.spent[i])} spent`);
      } else {
        setMeta(meta, fmt(v.share), 'budget');
      }
    });
  }

  // ---------- wiring ----------
  $('startBtn').addEventListener('click', startPause);
  $('finishBtn').addEventListener('click', finish);
  $('resetBtn').addEventListener('click', reset);
  $('undoBtn').addEventListener('click', undo);
  $('toastClose').addEventListener('click', hideToast);
  $('soundBtn').addEventListener('click', () => {
    s.sound = !s.sound;
    unlockAudio();
    save();
    render();
  });
  $('totalInput').addEventListener('change', applySetup);
  $('countInput').addEventListener('change', applySetup);
  list.addEventListener('click', (e) => {
    const li = e.target.closest('.item');
    if (li) switchTo(Number(li.dataset.i));
  });
  switcher.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) switchTo(Number(b.dataset.i));
  });
  document.addEventListener('visibilitychange', render);

  buildList();
  render();
  setInterval(render, 250);
})();
