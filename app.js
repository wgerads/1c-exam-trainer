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
  const EXAM_KEY = 'exam1c.exam.current.v1'; // незавершённый экзамен (переживает перезагрузку)
  const EXAM_HISTORY_KEY = 'exam1c.exam.history.v1';
  const EXAM_HISTORY_LIMIT = 20;

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
    closeLightbox();
    root.textContent = '';
  }

  // --- Картинки к вопросам ---
  //
  // Картинки вырезаны со скриншотов тренажёра и довольно мелкие, поэтому по
  // нажатию открываются увеличенными поверх страницы (Esc или клик — закрыть).

  let lightbox = null;

  function questionImage(question) {
    const image = question.image;
    if (!image || !image.src) return null;
    const img = el('img', {
      class: 'question__image',
      src: image.src,
      width: image.w,
      height: image.h,
      alt: 'Иллюстрация к вопросу',
      loading: 'lazy',
      decoding: 'async',
    });
    return el(
      'button',
      {
        type: 'button',
        class: 'question__figure',
        title: 'Открыть картинку крупно',
        'aria-label': 'Открыть картинку крупно',
        onclick: (event) => {
          event.stopPropagation();
          openLightbox(image);
        },
      },
      [img],
    );
  }

  function openLightbox(image) {
    closeLightbox();
    // Увеличиваем мелкие картинки, но не больше экрана.
    const scale = Math.min(3, Math.max(1, 900 / image.w));
    lightbox = el(
      'div',
      { class: 'lightbox', role: 'dialog', 'aria-label': 'Картинка к вопросу', onclick: closeLightbox },
      [
        el('img', {
          src: image.src,
          alt: 'Иллюстрация к вопросу',
          style: `width:${Math.round(image.w * scale)}px`,
        }),
        el('span', { class: 'lightbox__hint', text: 'Нажмите или Esc, чтобы закрыть' }),
      ],
    );
    document.body.appendChild(lightbox);
  }

  function closeLightbox() {
    if (lightbox) lightbox.remove();
    lightbox = null;
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

    root.appendChild(renderExamCard());

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
        el('button', { class: 'small', onclick: () => renderBrowse(category.id) }, 'Просмотр'),
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
    const figure = questionImage(question);
    if (figure) card.appendChild(figure);
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
    if (lightbox) {
      if (event.key === 'Escape' || event.key === 'Enter') {
        event.preventDefault();
        closeLightbox();
      }
      return;
    }
    if (exam.active) {
      onExamKeyDown(event);
      return;
    }
    if (browse.active) {
      if (event.key === 'Escape') leaveBrowse();
      return;
    }
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

  // --- Просмотр вопросов темы ---
  //
  // Все вопросы темы списком, правильный ответ сразу выделен. Без проверки
  // и без записи в прогресс — просто читать. Есть поиск по тексту вопроса
  // и вариантов и режим «только правильные ответы».

  const browse = { active: false, categoryId: null, query: '', onlyCorrect: false };

  function normalizeSearch(text) {
    return String(text || '').toLowerCase().replace(/ё/g, 'е');
  }

  function renderBrowse(categoryId) {
    browse.active = true;
    browse.categoryId = categoryId;
    browse.query = '';
    session.question = null;
    clearRoot();
    window.scrollTo(0, 0);

    const category = categoryById.get(categoryId);
    const questions = questionsByCategory.get(categoryId) || [];

    root.appendChild(
      el('header', { class: 'top' }, [
        el('div', { class: 'brand' }, [
          el('strong', { text: category ? category.title : categoryId }),
          el('span', { text: 'просмотр вопросов' }),
        ]),
        el('div', { class: 'row' }, [
          el('button', { class: 'small', onclick: () => { browse.active = false; startSession(categoryId, 'all'); } }, 'Повторять'),
          el('button', { class: 'ghost small', onclick: leaveBrowse, title: 'К списку тем (Esc)' }, 'Назад'),
        ]),
      ]),
    );

    const search = el('input', {
      type: 'search',
      class: 'browse__search',
      placeholder: 'Поиск по вопросам и ответам',
      'aria-label': 'Поиск по вопросам и ответам',
      autocomplete: 'off',
    });
    const onlyCorrect = el('input', { type: 'checkbox', id: 'browse-only-correct' });
    onlyCorrect.checked = browse.onlyCorrect;
    const counter = el('span', { class: 'muted' });

    root.appendChild(
      el('div', { class: 'browse__tools' }, [
        search,
        el('div', { class: 'row spread' }, [
          el('label', { class: 'browse__toggle', for: 'browse-only-correct' }, [onlyCorrect, ' Только правильные ответы']),
          counter,
        ]),
      ]),
    );

    const list = el('div', { class: 'categories' });
    root.appendChild(list);

    function draw() {
      const query = normalizeSearch(browse.query.trim());
      const shown = questions.filter(
        (q) =>
          !query ||
          normalizeSearch(q.text).includes(query) ||
          q.options.some((o) => normalizeSearch(o.text).includes(query)),
      );
      counter.textContent = query
        ? `Найдено ${shown.length} из ${questions.length}`
        : `${questions.length} ${plural(questions.length, 'вопрос', 'вопроса', 'вопросов')}`;

      list.textContent = '';
      if (!shown.length) {
        list.appendChild(el('div', { class: 'card empty', text: 'Ничего не найдено.' }));
        return;
      }
      for (const question of shown) {
        const status = Core.statusOf(question, progress);
        const options = el('div', { class: 'options locked' });
        question.options.forEach((option, index) => {
          if (browse.onlyCorrect && !option.correct) return;
          options.appendChild(
            el('div', { class: `option${option.correct ? ' is-correct' : ''}` }, [
              el('span', { class: 'option__key', text: String(index + 1) }),
              el('span', { class: 'option__text', text: option.text }),
            ]),
          );
        });
        const number = questions.indexOf(question) + 1;
        list.appendChild(
          el('div', { class: 'card' }, [
            el('div', { class: 'row spread' }, [
              el('div', { class: 'question__note', style: 'margin:0', text: `Вопрос ${number}` }),
              status === 'known' && el('span', { class: 'pill ok', text: 'Изучен' }),
              status === 'error' && el('span', { class: 'pill bad', text: 'С ошибкой' }),
            ]),
            el('div', { class: 'question', text: question.text }),
      questionImage(question),
            question.needsReview &&
              el('div', { class: 'question__note', text: '(помечен для проверки: формулировка могла распознаться не полностью)' }),
            options,
          ]),
        );
      }
    }

    search.addEventListener('input', () => {
      browse.query = search.value;
      draw();
    });
    onlyCorrect.addEventListener('change', () => {
      browse.onlyCorrect = onlyCorrect.checked;
      draw();
    });
    draw();
  }

  function leaveBrowse() {
    browse.active = false;
    renderHome();
  }

  // --- Режим экзамена ---
  //
  // Как на настоящем тестировании: билет из 14 вопросов (по одному из каждой
  // темы), 30 минут, зачёт от 12 верных. Правильные ответы во время экзамена
  // не показываются; между вопросами можно свободно переходить и менять ответ.

  const questionById = new Map(DATA.questions.map((q) => [q.id, q]));

  const exam = {
    active: false,
    questions: [],
    answers: [], // answers[i] — выбранные индексы вариантов
    pos: 0,
    startedAt: 0,
    deadline: 0,
    timerId: null,
  };

  function readJson(key) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }
  function writeJson(key, value) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      storageAvailable = false;
    }
  }

  function loadExamHistory() {
    const list = readJson(EXAM_HISTORY_KEY);
    return Array.isArray(list) ? list.filter((r) => r && typeof r === 'object') : [];
  }

  /** Незавершённый экзамен из хранилища (или null, если его нет либо он битый). */
  function loadSavedExam() {
    const saved = readJson(EXAM_KEY);
    if (!saved || !Array.isArray(saved.ids) || !saved.ids.length) return null;
    const questions = saved.ids.map((id) => questionById.get(id));
    if (questions.some((q) => !q)) return null; // банк обновился — старый билет не восстановить
    return {
      questions,
      answers: Array.isArray(saved.answers) ? saved.answers.map((a) => (Array.isArray(a) ? a : [])) : [],
      pos: Number(saved.pos) || 0,
      startedAt: Number(saved.startedAt) || Date.now(),
      deadline: Number(saved.deadline) || Date.now(),
    };
  }

  function persistExam() {
    writeJson(EXAM_KEY, {
      ids: exam.questions.map((q) => q.id),
      answers: exam.answers,
      pos: exam.pos,
      startedAt: exam.startedAt,
      deadline: exam.deadline,
    });
  }

  function secondsLeft() {
    return Math.max(0, Math.round((exam.deadline - Date.now()) / 1000));
  }

  function formatDate(stamp) {
    try {
      return new Date(stamp).toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (error) {
      return '';
    }
  }

  function renderExamCard() {
    const minutes = Math.round(Core.EXAM.durationSec / 60);
    const saved = loadSavedExam();
    const history = loadExamHistory();
    const passedCount = history.filter((r) => r.passed).length;

    const startButton = saved
      ? el('button', { class: 'primary', onclick: resumeExam }, `Продолжить экзамен`)
      : el('button', { class: 'primary', onclick: startExam }, 'Начать экзамен');

    const card = el('div', { class: 'card exam-card' }, [
      el('div', { class: 'row spread' }, [
        el('div', { class: 'grow' }, [
          el('h2', { text: 'Режим экзамена' }),
          el('p', { class: 'muted', style: 'margin:0' }, [
            `${Core.EXAM.questionCount} вопросов — по одному из каждой темы, ${minutes} минут, ` +
              `для зачёта нужно ${Core.EXAM.passScore} верных. Ответы покажут только в конце.`,
          ]),
        ]),
        el('div', { class: 'row' }, [
          saved && el('button', { class: 'small ghost', onclick: abandonSavedExam }, 'Начать заново'),
          startButton,
        ]),
      ]),
    ]);

    if (history.length) {
      const recent = history.slice(0, 5);
      card.appendChild(
        el('div', { class: 'exam-history' }, [
          el('div', { class: 'muted' }, [
            `Попыток: ${history.length}, сдано: ${passedCount}. Последние:`,
          ]),
          el(
            'ul',
            {},
            recent.map((r) =>
              el('li', {}, [
                el('span', { class: `pill ${r.passed ? 'ok' : 'bad'}`, text: r.passed ? 'Сдано' : 'Не сдано' }),
                ` ${r.correct} из ${r.total} · ${Core.formatTime(r.seconds)} · ${formatDate(r.at)}`,
              ]),
            ),
          ),
        ]),
      );
    }
    return card;
  }

  function startExam() {
    const questions = Core.buildExam(DATA.categories, questionsByCategory);
    if (!questions.length) {
      window.alert('Не удалось собрать билет: в банке нет вопросов.');
      return;
    }
    exam.questions = questions;
    exam.answers = questions.map(() => []);
    exam.pos = 0;
    exam.startedAt = Date.now();
    exam.deadline = exam.startedAt + Core.EXAM.durationSec * 1000;
    beginExam();
  }

  function resumeExam() {
    const saved = loadSavedExam();
    if (!saved) {
      renderHome();
      return;
    }
    Object.assign(exam, saved);
    exam.pos = Math.min(Math.max(0, exam.pos), exam.questions.length - 1);
    while (exam.answers.length < exam.questions.length) exam.answers.push([]);
    if (secondsLeft() <= 0) {
      exam.active = true;
      finishExam(true);
      return;
    }
    beginExam();
  }

  function abandonSavedExam() {
    if (!window.confirm('Удалить незавершённый экзамен и начать новый?')) return;
    writeJson(EXAM_KEY, null);
    startExam();
  }

  function beginExam() {
    exam.active = true;
    session.question = null;
    persistExam();
    stopExamTimer();
    exam.timerId = window.setInterval(tickExam, 1000);
    renderExam();
  }

  function stopExamTimer() {
    if (exam.timerId) window.clearInterval(exam.timerId);
    exam.timerId = null;
  }

  function tickExam() {
    const left = secondsLeft();
    const timer = document.getElementById('exam-timer');
    if (timer) {
      timer.textContent = Core.formatTime(left);
      timer.classList.toggle('low', left <= 5 * 60);
    }
    if (left <= 0) finishExam(true);
  }

  function answeredCount() {
    return exam.answers.filter((a) => a.length > 0).length;
  }

  function renderExam() {
    clearRoot();
    const question = exam.questions[exam.pos];
    const total = exam.questions.length;
    const selected = exam.answers[exam.pos];
    const left = secondsLeft();

    const head = el('div', { class: 'session__head' }, [
      el('div', { class: 'row spread' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'category__title', text: 'Экзамен' }),
          el('div', { class: 'session__meta' }, [
            el('span', { text: `Вопрос ${exam.pos + 1} из ${total} · отвечено ${answeredCount()}` }),
          ]),
        ]),
        el('span', {
          id: 'exam-timer',
          class: `exam-timer${left <= 5 * 60 ? ' low' : ''}`,
          title: 'Осталось времени',
          text: Core.formatTime(left),
        }),
        el('button', { class: 'ghost small', onclick: confirmLeaveExam, title: 'Прервать (Esc)' }, 'Прервать'),
      ]),
      el(
        'div',
        { class: 'exam-nav', role: 'navigation', 'aria-label': 'Вопросы билета' },
        exam.questions.map((q, i) =>
          el(
            'button',
            {
              type: 'button',
              class: `exam-nav__item${exam.answers[i].length ? ' is-answered' : ''}${i === exam.pos ? ' is-current' : ''}`,
              'aria-current': i === exam.pos ? 'true' : false,
              title: q.categoryTitle,
              onclick: () => goToExamQuestion(i),
            },
            String(i + 1),
          ),
        ),
      ),
    ]);
    root.appendChild(head);

    const card = el('div', { class: 'card' }, [
      el('div', { class: 'question__note', text: question.categoryTitle }),
      el('div', { class: 'question', text: question.text }),
      questionImage(question),
      question.multi &&
        el('div', { class: 'question__note', text: 'Несколько правильных вариантов — отметьте все.' }),
    ]);
    const options = el('div', { class: 'options' });
    question.options.forEach((option, index) => {
      const picked = selected.includes(index);
      options.appendChild(
        el(
          'button',
          {
            class: `option${picked ? ' is-picked' : ''}`,
            type: 'button',
            'aria-pressed': picked ? 'true' : 'false',
            onclick: () => toggleExamOption(index),
          },
          [
            el('span', { class: 'option__key', text: String(index + 1) }),
            el('span', { class: 'option__text', text: option.text }),
          ],
        ),
      );
    });
    card.appendChild(options);
    root.appendChild(card);

    const isLast = exam.pos >= total - 1;
    root.appendChild(
      el('div', { class: 'session__foot' }, [
        el('button', { onclick: () => goToExamQuestion(exam.pos - 1), disabled: exam.pos === 0 }, 'Назад'),
        el('span', { class: 'muted', html: '<kbd>1</kbd>…<kbd>9</kbd> — ответ, <kbd>←</kbd> <kbd>→</kbd> — вопросы' }),
        isLast
          ? el('button', { class: 'primary', onclick: confirmFinishExam }, 'Завершить')
          : el('button', { class: 'primary', onclick: () => goToExamQuestion(exam.pos + 1) }, 'Далее'),
      ]),
    );
    if (!isLast) {
      root.appendChild(
        el('div', { class: 'toolbar', style: 'justify-content:flex-end' }, [
          el('button', { class: 'small ghost', onclick: confirmFinishExam }, 'Завершить досрочно'),
        ]),
      );
    }
  }

  function toggleExamOption(index) {
    const question = exam.questions[exam.pos];
    const current = exam.answers[exam.pos];
    if (question.multi) {
      const at = current.indexOf(index);
      if (at >= 0) current.splice(at, 1);
      else current.push(index);
    } else {
      exam.answers[exam.pos] = current.length === 1 && current[0] === index ? [] : [index];
    }
    persistExam();
    renderExam();
  }

  function goToExamQuestion(index) {
    if (index < 0 || index >= exam.questions.length) return;
    exam.pos = index;
    persistExam();
    renderExam();
    window.scrollTo(0, 0);
  }

  function confirmFinishExam() {
    const missing = exam.questions.length - answeredCount();
    const text = missing
      ? `Без ответа ${missing} ${plural(missing, 'вопрос', 'вопроса', 'вопросов')} — они будут засчитаны как неверные. Завершить экзамен?`
      : 'Завершить экзамен и посмотреть результат?';
    if (window.confirm(text)) finishExam(false);
  }

  function confirmLeaveExam() {
    if (!window.confirm('Прервать экзамен? Результат не будет засчитан.')) return;
    stopExamTimer();
    exam.active = false;
    writeJson(EXAM_KEY, null);
    renderHome();
  }

  function finishExam(timeUp) {
    if (!exam.active) return;
    stopExamTimer();
    exam.active = false;

    const result = Core.gradeExam(exam.questions, exam.answers);
    const finishedAt = Math.min(Date.now(), exam.deadline);
    const seconds = Math.round((finishedAt - exam.startedAt) / 1000);

    // Ответы экзамена попадают в общий прогресс: ошибки появятся в «Ошибки» по темам.
    result.items.forEach((item) => Core.recordAnswer(progress, item.id, item.ok));
    saveProgress(progress);

    const history = loadExamHistory();
    history.unshift({
      at: Date.now(),
      correct: result.correct,
      total: result.total,
      passed: result.passed,
      seconds,
      timeUp: Boolean(timeUp),
    });
    writeJson(EXAM_HISTORY_KEY, history.slice(0, EXAM_HISTORY_LIMIT));
    writeJson(EXAM_KEY, null);

    renderExamResult(result, seconds, timeUp);
  }

  function renderExamResult(result, seconds, timeUp) {
    clearRoot();
    window.scrollTo(0, 0);

    root.appendChild(
      el('div', { class: 'top' }, [
        el('div', { class: 'brand' }, [el('strong', { text: 'Экзамен' }), el('span', { text: 'результат' })]),
      ]),
    );

    root.appendChild(
      el('div', { class: `exam-result ${result.passed ? 'ok' : 'bad'}` }, [
        el('b', { text: result.passed ? 'Сдано' : 'Не сдано' }),
        el('span', {
          text:
            `${result.correct} из ${result.total} верных, нужно ${result.need}` +
            (timeUp ? ' · время вышло' : ''),
        }),
      ]),
    );

    const wrong = result.items.filter((i) => i.answered && !i.ok).length;
    const skipped = result.items.filter((i) => !i.answered).length;
    root.appendChild(
      el('div', { class: 'summary__grid' }, [
        el('div', { class: 'stat' }, [el('b', { text: String(result.correct) }), 'верно']),
        el('div', { class: 'stat' }, [el('b', { text: String(wrong) }), 'ошибок']),
        el('div', { class: 'stat' }, [el('b', { text: String(skipped) }), 'без ответа']),
        el('div', { class: 'stat' }, [el('b', { text: Core.formatTime(seconds) }), 'затрачено']),
      ]),
    );

    root.appendChild(
      el('div', { class: 'toolbar', style: 'margin-top:0' }, [
        el('button', { class: 'primary', onclick: startExam }, 'Новый экзамен'),
        el('button', { class: 'ghost', onclick: renderHome }, 'К списку тем'),
      ]),
    );

    root.appendChild(el('h2', { style: 'margin:24px 0 12px', text: 'Разбор билета' }));
    const list = el('div', { class: 'categories' });
    result.items.forEach((item, i) => {
      const question = exam.questions[i];
      const correct = Core.correctIndexes(question);
      const status = item.ok ? 'Верно' : item.answered ? 'Неверно' : 'Без ответа';
      const options = el('div', { class: 'options locked' });
      question.options.forEach((option, index) => {
        const chosen = item.selected.includes(index);
        let cls = 'option';
        if (correct.includes(index)) cls += ' is-correct';
        else if (chosen) cls += ' is-chosen-wrong';
        options.appendChild(
          el('div', { class: cls }, [
            el('span', { class: 'option__key', text: String(index + 1) }),
            el('span', { class: 'option__text', text: option.text }),
          ]),
        );
      });
      list.appendChild(
        el('div', { class: 'card' }, [
          el('div', { class: 'row spread' }, [
            el('div', { class: 'question__note', style: 'margin:0', text: `${i + 1}. ${question.categoryTitle}` }),
            el('span', { class: `pill ${item.ok ? 'ok' : 'bad'}`, text: status }),
          ]),
          el('div', { class: 'question', text: question.text }),
      questionImage(question),
          options,
        ]),
      );
    });
    root.appendChild(list);
  }

  function onExamKeyDown(event) {
    if (event.key === 'Escape') {
      confirmLeaveExam();
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'Enter') {
      event.preventDefault();
      if (exam.pos < exam.questions.length - 1) goToExamQuestion(exam.pos + 1);
      else if (event.key === 'Enter') confirmFinishExam();
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      goToExamQuestion(exam.pos - 1);
      return;
    }
    const digit = Number(event.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
      const question = exam.questions[exam.pos];
      if (digit - 1 < question.options.length) {
        event.preventDefault();
        toggleExamOption(digit - 1);
      }
    }
  }

  // --- запуск ---

  renderHome();
})();
