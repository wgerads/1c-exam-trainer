/**
 * Тренажёр 1С:Профессионал: интерфейс, состояние сессии, прогресс.
 * Вся расчётная логика — в app-core.js; здесь DOM, события и localStorage.
 */
(function () {
  'use strict';

  const Core = window.AppCore;
  const DATA = window.EXAM_DATA;
  const STORAGE_KEY = 'exam1c.progress.v1';
  const MAX_REQUEUE_PER_QUESTION = 2; // сколько раз возвращать вопрос в очередь за сессию

  const root = document.getElementById('app');
  if (!Core || !DATA || !Array.isArray(DATA.questions)) {
    root.innerHTML =
      '<div class="card empty"><h2>Не найден банк вопросов</h2>' +
      '<p class="muted">Рядом с файлом index.html должен лежать <code>data/questions.js</code>. ' +
      'Он собирается командой <code>node tools/build-bank.mjs</code>.</p></div>';
    return;
  }

  // --- прогресс ---

  let storageAvailable = true;
  function loadProgress() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return Core.normalizeProgress(raw ? JSON.parse(raw) : null);
    } catch (error) {
      storageAvailable = false;
      return Core.emptyProgress();
    }
  }
  function saveProgress(progress) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
    } catch (error) {
      storageAvailable = false;
    }
  }

  let progress = loadProgress();
  const questionsByCategory = new Map();
  for (const question of DATA.questions) {
    if (!questionsByCategory.has(question.categoryId)) questionsByCategory.set(question.categoryId, []);
    questionsByCategory.get(question.categoryId).push(question);
  }
  const categoryById = new Map((DATA.categories || []).map((c) => [c.id, c]));

  // --- утилиты DOM ---

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value === true ? '' : value);
      }
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function clearRoot() {
    root.textContent = '';
  }

  function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
  }

  // --- состояние сессии ---

  const session = {
    categoryId: null,
    queue: [],
    pos: 0,
    question: null,
    selected: [],
    answered: false,
    attempts: new Map(),
    answeredIds: new Set(),
    stats: { answers: 0, correct: 0, wrong: 0 },
  };

  // --- Экран: список тем ---

  function renderHome() {
    clearRoot();

    const totals = DataTotals();
    const head = el('header', { class: 'top' }, [
      el('div', { class: 'brand' }, [
        el('strong', { text: '1С:Профессионал' }),
        el('span', { text: 'тренажёр вопросов' }),
      ]),
      el('button', { class: 'ghost small', onclick: renderHome, title: 'Обновить сводку' }, 'Обновить'),
    ]);
    root.appendChild(head);

    root.appendChild(
      el('div', { class: 'card', style: 'margin-bottom:16px' }, [
        el('div', { class: 'row spread' }, [
          el('div', { class: 'grow' }, [
            el('h2', { text: `Всего вопросов: ${totals.total}` }),
            el('div', { class: 'legend' }, [
              el('span', {}, [el('b', { text: String(totals.known) }), ' изучено']),
              el('span', {}, [el('b', { text: String(totals.errors) }), ' с ошибками']),
              el('span', {}, [el('b', { text: String(totals.untouched) }), ' не начато']),
            ]),
          ]),
        ]),
        el('div', { class: 'bar', style: 'margin-top:12px' }, [
          el('i', { style: `width:${totals.percent}%` }),
        ]),
        el('p', { class: 'muted', style: 'margin:8px 0 0' }, `Изучено ${totals.percent}% банка`),
      ]),
    );

    const list = el('div', { class: 'categories' });
    for (const category of DATA.categories || []) {
      const questions = questionsByCategory.get(category.id) || [];
      if (!questions.length) continue;
      const summary = Core.progressFor(questions, progress);
      const actions = el('div', { class: 'category__actions' }, [
        el(
          'button',
          {
            class: 'primary small',
            onclick: () => startSession(category.id, 'all'),
          },
          'Повторять',
        ),
        summary.errors > 0 &&
          el(
            'button',
            { class: 'small', onclick: () => startSession(category.id, 'errors') },
            `Ошибки ${summary.errors}`,
          ),
        summary.untouched > 0 &&
          el(
            'button',
            { class: 'small', onclick: () => startSession(category.id, 'unknown') },
            `Новые ${summary.untouched}`,
          ),
      ]);

      list.appendChild(
        el('div', { class: 'card category' }, [
          el('div', {}, [
            el('div', { class: 'category__title', text: category.title }),
            el('div', { class: 'category__meta' }, [
              `${questions.length} ${plural(questions.length, 'вопрос', 'вопроса', 'вопросов')}`,
              summary.known > 0 && ` · изучено ${summary.known}`,
              summary.errors > 0 && ` · ошибок ${summary.errors}`,
            ]),
          ]),
          actions,
          el('div', { class: 'bar brand' }, [el('i', { style: `width:${summary.percent}%` })]),
        ]),
      );
    }
    root.appendChild(list);

    const reset = () => {
      if (!window.confirm('Сбросить весь прогресс? Это действие нельзя отменить.')) return;
      progress = Core.emptyProgress();
      saveProgress(progress);
      renderHome();
    };
    const exportProgress = () => {
      const blob = new Blob([JSON.stringify(progress, null, 2)], { type: 'application/json' });
      const link = el('a', { href: URL.createObjectURL(blob), download: 'progress-1c-trainer.json' });
      document.body.appendChild(link);
      link.click();
      link.remove();
    };
    const importProgress = () => {
      const input = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            progress = Core.normalizeProgress(JSON.parse(String(reader.result)));
            saveProgress(progress);
            renderHome();
          } catch (error) {
            window.alert('Не удалось прочитать файл прогресса.');
          }
        };
        reader.readAsText(file);
      });
      document.body.appendChild(input);
      input.click();
      input.remove();
    };

    root.appendChild(
      el('div', { class: 'toolbar' }, [
        el('button', { class: 'small', onclick: exportProgress }, 'Сохранить прогресс в файл'),
        el('button', { class: 'small', onclick: importProgress }, 'Загрузить прогресс'),
        el('button', { class: 'small', onclick: reset }, 'Сбросить прогресс'),
      ]),
    );

    if (!storageAvailable) {
      root.appendChild(
        el('p', { class: 'muted', style: 'margin-top:12px' }, [
          'Браузер запретил локальное хранилище для этого файла — прогресс не сохранится между запусками. ' +
            'Откройте папку через локальный веб-сервер или разрешите хранилище для страницы.',
        ]),
      );
    }

    root.appendChild(
      el('p', { class: 'muted', style: 'margin-top:18px' }, [
        'Вопросы и ответы извлечены из ваших скриншотов: правильный вариант отмечен по зелёной подсветке кнопки. ' +
          'Всего в банке ' + DATA.questions.length + ' ' + plural(DATA.questions.length, 'вопрос', 'вопроса', 'вопросов') + '.',
      ]),
    );
  }

  function DataTotals() {
    return Core.progressFor(DATA.questions, progress);
  }

  // --- Экран: сессия ---

  function startSession(categoryId, mode) {
    const all = questionsByCategory.get(categoryId) || [];
    const queue = Core.buildQueue(all, progress, mode);
    if (!queue.length) {
      window.alert(mode === 'errors' ? 'В этой теме пока нет вопросов с ошибками.' : 'В этой теме нет вопросов.');
      return;
    }
    session.categoryId = categoryId;
    session.queue = queue;
    session.pos = 0;
    session.attempts = new Map();
    session.answeredIds = new Set();
    session.stats = { answers: 0, correct: 0, wrong: 0 };
    nextQuestion();
  }

  function nextQuestion() {
    if (session.pos >= session.queue.length) {
      renderSummary();
      return;
    }
    session.question = session.queue[session.pos];
    session.selected = [];
    session.answered = false;
    renderSession();
  }

  function categoryTitle() {
    const category = categoryById.get(session.categoryId);
    return category ? category.title : session.categoryId;
  }

  function renderSession() {
    clearRoot();
    const question = session.question;
    const total = session.queue.length;

    const remainingEl = el('span', { text: `Осталось ${total - session.pos}` });
    const statsEl = el('span', { text: `верно ${session.stats.correct} · ошибок ${session.stats.wrong}` });
    session.metaEls = { remainingEl, statsEl };

    const head = el('div', { class: 'session__head' }, [
      el('div', { class: 'row spread' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'category__title', text: categoryTitle() }),
          el('div', { class: 'session__meta' }, [remainingEl, statsEl]),
        ]),
        el('button', { class: 'ghost small', onclick: exitSession, title: 'Выйти (Esc)' }, 'Выйти'),
      ]),
      el('div', { class: 'bar', style: 'margin-top:10px' }, [
        el('i', {
          id: 'session-bar',
          style: `width:${total ? Math.round((session.answeredIds.size / total) * 100) : 0}%`,
        }),
      ]),
    ]);
    root.appendChild(head);

    const banner = el('div', { class: 'banner', id: 'banner' });
    root.appendChild(banner);

    const card = el('div', { class: 'card' }, []);
    card.appendChild(el('div', { class: 'question', text: question.text }));
    const notes = [];
    if (question.questionTruncated) notes.push('в кадре текст вопроса был обрезан');
    if (question.needsReview) notes.push('помечен для проверки');
    if (notes.length) {
      card.appendChild(el('div', { class: 'question__note', text: `(${notes.join('; ')})` }));
    }
    if (question.multi) {
      card.appendChild(el('div', { class: 'question__note', text: 'Вопрос с несколькими правильными вариантами — отметьте все и нажмите «Проверить».' }));
    }

    const options = el('div', { class: 'options', id: 'options' }, []);
    question.options.forEach((option, index) => {
      const key = String.fromCharCode(1040 + index).toLowerCase(); // а, б, в, …
      const button = el(
        'button',
        {
          class: 'option',
          type: 'button',
          dataset: { index: String(index) },
          'aria-pressed': 'false',
          onclick: () => onOptionClick(index),
        },
        [
          el('span', { class: 'option__key', text: String(index + 1) }),
          el('span', { class: 'option__text', text: option.text }),
        ],
      );
      options.appendChild(button);
    });
    card.appendChild(options);
    root.appendChild(card);

    const checkButton = el(
      'button',
      { class: 'primary', id: 'action', onclick: onPrimaryAction },
      question.multi && !session.answered ? 'Проверить' : 'Дальше',
    );
    // До ответа кнопка не нужна: в одиночном вопросе ответ даёт клик по варианту,
    // в многоответном она появляется после первого выбора.
    checkButton.classList.add('hidden');
    const foot = el('div', { class: 'session__foot' }, [
      el('span', { class: 'muted', html: 'Ответ: <kbd>1</kbd>…<kbd>9</kbd>, дальше — <kbd>Enter</kbd>' }),
      checkButton,
    ]);
    root.appendChild(foot);
  }

  function onOptionClick(index) {
    if (session.answered) return;
    const question = session.question;
    if (question.multi) {
      const at = session.selected.indexOf(index);
      if (at >= 0) session.selected.splice(at, 1);
      else session.selected.push(index);
      renderSelectionState();
      return;
    }
    session.selected = [index];
    answer();
  }

  function renderSelectionState() {
    root.querySelectorAll('.option').forEach((node) => {
      const index = Number(node.dataset.index);
      const picked = session.selected.includes(index);
      node.classList.toggle('is-picked', picked);
      node.setAttribute('aria-pressed', picked ? 'true' : 'false');
    });
    const action = document.getElementById('action');
    if (action) action.classList.toggle('hidden', session.selected.length === 0);
  }

  function onPrimaryAction() {
    if (!session.answered) {
      if (!session.selected.length) return;
      answer();
    } else {
      session.pos += 1;
      nextQuestion();
    }
  }

  function answer() {
    const question = session.question;
    const isCorrect = Core.checkAnswer(question, session.selected);
    session.answered = true;
    session.stats.answers += 1;
    if (isCorrect) session.stats.correct += 1;
    else session.stats.wrong += 1;

    Core.recordAnswer(progress, question.id, isCorrect);
    saveProgress(progress);

    if (isCorrect) {
      session.answeredIds.add(question.id);
    } else {
      const attempts = (session.attempts.get(question.id) || 0) + 1;
      session.attempts.set(question.id, attempts);
      if (attempts <= MAX_REQUEUE_PER_QUESTION) {
        session.queue.push(question); // вернём вопрос в конец очереди
      }
    }

    const correct = Core.correctIndexes(question);
    root.querySelector('.options').classList.add('locked');
    root.querySelectorAll('.option').forEach((node) => {
      const index = Number(node.dataset.index);
      const chosen = session.selected.includes(index);
      if (correct.includes(index)) node.classList.add('is-correct');
      else if (chosen) node.classList.add('is-chosen-wrong');
      node.classList.remove('is-picked');
      node.disabled = false;
    });

    const banner = document.getElementById('banner');
    banner.textContent = isCorrect ? 'Верно' : 'Неверно';
    banner.className = `banner show ${isCorrect ? 'ok' : 'bad'}`;

    // Обновляем счётчики и полосу сразу, не дожидаясь следующего вопроса.
    if (session.metaEls) {
      session.metaEls.remainingEl.textContent = `Осталось ${Math.max(0, session.queue.length - session.pos - 1)}`;
      session.metaEls.statsEl.textContent = `верно ${session.stats.correct} · ошибок ${session.stats.wrong}`;
    }
    const sessionBar = document.getElementById('session-bar');
    if (sessionBar) {
      const total = session.queue.length || 1;
      sessionBar.style.width = `${Math.min(100, Math.round((session.answeredIds.size / total) * 100))}%`;
    }

    const action = document.getElementById('action');
    action.textContent = session.pos + 1 >= session.queue.length ? 'Итоги' : 'Дальше';
    action.classList.remove('hidden');
    action.focus();
  }

  function onKeyDown(event) {
    if (!session.question || !root.querySelector('.options')) return;
    const question = session.question;
    if (event.key === 'Escape') {
      exitSession();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (session.answered) {
        if (!document.getElementById('action').classList.contains('hidden')) onPrimaryAction();
      } else if (session.selected.length) {
        answer();
      }
      return;
    }
    const digit = Number(event.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
      const index = digit - 1;
      if (index < question.options.length) {
        event.preventDefault();
        onOptionClick(index);
      }
    }
  }

  // Единственный обработчик клавиатуры на всё приложение: он сам понимает,
  // на каком экране находится пользователь.
  document.addEventListener('keydown', onKeyDown);

  function exitSession() {
    session.question = null;
    renderHome();
  }

  // --- Экран: итоги ---

  function renderSummary() {
    clearRoot();
    const stats = session.stats;
    const answered = stats.correct + stats.wrong;
    const percent = answered ? Math.round((stats.correct / answered) * 100) : 0;

    root.appendChild(
      el('div', { class: 'top' }, [
        el('div', { class: 'brand' }, [
          el('strong', { text: categoryTitle() }),
          el('span', { text: 'итоги сессии' }),
        ]),
      ]),
    );

    const card = el('div', { class: 'card' }, [
      el('h2', { text: 'Сессия завершена' }),
      el('div', { class: 'summary__grid' }, [
        el('div', { class: 'stat' }, [el('b', { text: String(stats.correct) }), 'верных ответов']),
        el('div', { class: 'stat' }, [el('b', { text: String(stats.wrong) }), 'ошибок']),
        el('div', { class: 'stat' }, [el('b', { text: `${percent}%` }), 'доля верных']),
        el('div', { class: 'stat' }, [el('b', { text: String(stats.answers) }), 'всего ответов']),
      ]),
      el('p', { class: 'muted' }, [
        'Прогресс сохранён. Вопросы, отвеченные неверно, вернулись в очередь этой сессии ' +
          `(не более ${MAX_REQUEUE_PER_QUESTION} раз каждый) и остались помеченными как «с ошибкой».`,
      ]),
    ]);
    root.appendChild(card);

    const summary = Core.progressFor(questionsByCategory.get(session.categoryId) || [], progress);
    root.appendChild(
      el('p', { class: 'muted', style: 'margin-top:12px' }, [
        `В теме «${categoryTitle()}» изучено ${summary.known} из ${summary.total} (${summary.percent}%), с ошибками ${summary.errors}.`,
      ]),
    );

    const foot = el('div', { class: 'toolbar' }, [
      summary.errors > 0 &&
        el('button', { class: 'primary', onclick: () => startSession(session.categoryId, 'errors') }, `Повторить ошибки (${summary.errors})`),
      el('button', { onclick: () => startSession(session.categoryId, 'all') }, 'Пройти тему заново'),
      el('button', { class: 'ghost', onclick: renderHome }, 'К списку тем'),
    ]);
    root.appendChild(foot);
  }

  // --- запуск ---

  renderHome();
})();
