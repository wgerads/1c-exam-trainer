/**
 * Чистая логика тренажёра: очередь вопросов, проверка ответа, прогресс.
 * Здесь нет работы с DOM и localStorage — всё это тестируется в Node
 * (см. tools/test-app-core.mjs) и не зависит от браузера.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AppCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORAGE_VERSION = 1;

  // --- Интервальное повторение ---
  //
  // У вопроса есть «коробка» (box): верный ответ в срок переносит его в следующую,
  // ошибка возвращает в нулевую. BOX_INTERVALS[box] — через сколько дней пора повторять.
  const BOX_INTERVALS = [0, 1, 3, 7, 14, 30];
  const MAX_BOX = BOX_INTERVALS.length - 1;
  /** Вопрос изучен: 3 верных ответа подряд или верные ответы в разные дни (box ≥ 2). */
  const KNOWN_STREAK = 3;
  const KNOWN_BOX = 2;

  /** Номер календарного дня по местному времени. */
  function dayNumber(stamp) {
    const d = new Date(stamp);
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  }

  /** Пора ли повторять вопрос. */
  function isDue(entry, now) {
    return dayNumber(now) - dayNumber(entry.last) >= BOX_INTERVALS[entry.box || 0];
  }

  /** Правильные индексы вопроса. */
  function correctIndexes(question) {
    return (question.options || []).map((o, i) => (o.correct === true ? i : -1)).filter((i) => i >= 0);
  }

  /** Совпал ли выбранный набор с правильным (для многоответных — точное равенство). */
  function checkAnswer(question, selected) {
    const correct = correctIndexes(question);
    const chosen = Array.from(new Set(selected)).sort((a, b) => a - b);
    if (chosen.length !== correct.length) return false;
    return chosen.every((value, i) => value === correct[i]);
  }

  /** Перемешивание Фишера–Йетса; rng подставляется в тестах. */
  function shuffle(items, rng) {
    const random = rng || Math.random;
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** Пустое состояние прогресса. */
  function emptyProgress() {
    return { version: STORAGE_VERSION, questions: {} };
  }

  /** Приводим прочитанный прогресс к ожидаемому виду (защита от битого хранилища). */
  function normalizeProgress(raw) {
    const out = emptyProgress();
    if (!raw || typeof raw !== 'object') return out;
    const source = raw.questions && typeof raw.questions === 'object' ? raw.questions : {};
    for (const [id, value] of Object.entries(source)) {
      if (!value || typeof value !== 'object') continue;
      const seen = Number(value.seen) || 0;
      const correct = Number(value.correct) || 0;
      const wrong = Number(value.wrong) || 0;
      if (seen <= 0 && correct <= 0 && wrong <= 0) continue;
      // В старом прогрессе этих полей нет: один верный ответ — первая ступень, а не «изучено».
      const ok = value.ok === true;
      const streak = Number.isFinite(value.streak) ? Math.max(0, value.streak) : ok ? 1 : 0;
      const box = Number.isFinite(value.box) ? Math.min(MAX_BOX, Math.max(0, value.box)) : ok ? 1 : 0;
      out.questions[id] = {
        seen,
        correct,
        wrong,
        ok,
        last: Number(value.last) || 0,
        streak,
        box,
      };
    }
    return out;
  }

  /** Избранное: массив id вопросов без повторов, только известные id (если список передан). */
  function normalizeFavorites(raw, knownIds) {
    const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.favorites) ? raw.favorites : [];
    const out = [];
    for (const id of list) {
      if (typeof id !== 'string' || out.includes(id)) continue;
      if (knownIds && !knownIds.has(id)) continue;
      out.push(id);
    }
    return out;
  }

  /** Добавляет вопрос в избранное или убирает его оттуда. Возвращает новый список. */
  function toggleFavorite(favorites, questionId) {
    return favorites.includes(questionId)
      ? favorites.filter((id) => id !== questionId)
      : favorites.concat(questionId);
  }

  function recordAnswer(progress, questionId, isCorrect, now) {
    const stamp = now || Date.now();
    const prev = progress.questions[questionId] || { seen: 0, correct: 0, wrong: 0, ok: false, last: 0, streak: 0, box: 0 };
    const prevBox = prev.box || 0;
    const advance = prev.seen === 0 || prevBox === 0 || isDue(prev, stamp);
    progress.questions[questionId] = {
      seen: prev.seen + 1,
      correct: prev.correct + (isCorrect ? 1 : 0),
      wrong: prev.wrong + (isCorrect ? 0 : 1),
      ok: isCorrect,
      last: stamp,
      streak: isCorrect ? (prev.streak || 0) + 1 : 0,
      box: !isCorrect ? 0 : advance ? Math.min(MAX_BOX, prevBox + 1) : prevBox,
    };
    return progress;
  }

  /** Статус вопроса: known — изучен, learning — в работе, error — с ошибкой, untouched — не начат. */
  function statusOf(question, progress) {
    const entry = progress.questions ? progress.questions[question.id] : null;
    if (!entry || entry.seen === 0) return 'untouched';
    if (!entry.ok) return 'error';
    return (entry.streak || 0) >= KNOWN_STREAK || (entry.box || 0) >= KNOWN_BOX ? 'known' : 'learning';
  }

  /** Сводка по списку вопросов: всего / изучено / с ошибками / не начато. */
  function progressFor(questions, progress) {
    const summary = { total: questions.length, known: 0, learning: 0, errors: 0, untouched: 0, attempts: 0, wrong: 0 };
    for (const question of questions) {
      const entry = progress.questions ? progress.questions[question.id] : null;
      if (entry) {
        summary.attempts += entry.seen;
        summary.wrong += entry.wrong;
      }
      const status = statusOf(question, progress);
      if (status === 'known') summary.known += 1;
      else if (status === 'learning') summary.learning += 1;
      else if (status === 'error') summary.errors += 1;
      else summary.untouched += 1;
    }
    summary.percent = summary.total ? Math.round((summary.known / summary.total) * 100) : 0;
    return summary;
  }

  /**
   * Очередь сессии.
   * mode: 'all' — все вопросы; 'new' — ещё не решённые; 'unknown' — все, кроме изученных;
   * 'errors' — только с ошибками.
   */
  function buildQueue(questions, progress, mode, rng) {
    let list = questions.slice();
    if (mode === 'new') list = list.filter((q) => statusOf(q, progress) === 'untouched');
    else if (mode === 'unknown') list = list.filter((q) => statusOf(q, progress) !== 'known');
    else if (mode === 'errors') list = list.filter((q) => statusOf(q, progress) === 'error');
    return shuffle(list, rng);
  }

  // --- Подборка «На сегодня» ---

  const DAILY = { limit: 30, newLimit: 10 };

  /** Новые вопросы поровну из разных тем. */
  function balanceByCategory(questions) {
    const groups = new Map();
    for (const q of questions) {
      if (!groups.has(q.categoryId)) groups.set(q.categoryId, []);
      groups.get(q.categoryId).push(q);
    }
    const lists = Array.from(groups.values());
    const out = [];
    for (let i = 0; out.length < questions.length; i += 1) {
      for (const list of lists) if (i < list.length) out.push(list[i]);
    }
    return out;
  }

  /**
   * Ошибки прошлых дней, затем вопросы, которые пора повторить, затем новые.
   * Сегодняшние ошибки не берём: их перерешивают с экрана итогов, а подборка должна заканчиваться.
   */
  function buildDaily(questions, progress, options) {
    const opts = options || {};
    const now = opts.now || Date.now();
    const limit = opts.limit || DAILY.limit;
    const newLimit = opts.newLimit === undefined ? DAILY.newLimit : opts.newLimit;
    const today = dayNumber(now);
    const entryOf = (q) => progress.questions[q.id];
    const byOldest = (a, b) => entryOf(a).last - entryOf(b).last;
    const pool = shuffle(questions, opts.rng);

    const errors = pool
      .filter((q) => statusOf(q, progress) === 'error' && dayNumber(entryOf(q).last) < today)
      .sort(byOldest);
    const due = pool
      .filter((q) => ['known', 'learning'].includes(statusOf(q, progress)) && isDue(entryOf(q), now))
      .sort(byOldest);
    const fresh = balanceByCategory(pool.filter((q) => statusOf(q, progress) === 'untouched'));

    const review = errors.concat(due).slice(0, limit - Math.min(newLimit, fresh.length));
    const added = fresh.slice(0, limit - review.length);
    const errorCount = Math.min(errors.length, review.length);
    return {
      queue: shuffle(review.concat(added), opts.rng),
      counts: { errors: errorCount, due: review.length - errorCount, fresh: added.length },
    };
  }

  /** Сколько вопросов решено сегодня. */
  function answeredToday(progress, now) {
    const today = dayNumber(now || Date.now());
    return Object.values(progress.questions).filter((entry) => dayNumber(entry.last) === today).length;
  }

  // --- Прогноз экзамена ---

  /** Условная вероятность верного ответа по статусу вопроса (экспертная оценка, не статистика). */
  const RECALL = { known: 0.95, learning: 0.75, error: 0.4, untouched: 0.3 };

  /** Вероятность набрать не меньше need верных, если в i-м вопросе шанс равен chances[i]. */
  function passProbability(chances, need) {
    let dist = [1];
    for (const p of chances) {
      const next = new Array(dist.length + 1).fill(0);
      dist.forEach((value, k) => {
        next[k] += value * (1 - p);
        next[k + 1] += value * p;
      });
      dist = next;
    }
    return dist.slice(Math.max(0, need)).reduce((sum, value) => sum + value, 0);
  }

  /** Прогноз по билету: шанс сдать, ожидаемый балл и темы от слабых к сильным. */
  function forecast(categories, byCategory, progress) {
    const topics = [];
    for (const category of categories || []) {
      const questions = byCategory.get(category.id) || [];
      if (!questions.length) continue;
      const summary = progressFor(questions, progress);
      const chance = questions.reduce((sum, q) => sum + RECALL[statusOf(q, progress)], 0) / questions.length;
      topics.push({
        id: category.id,
        title: category.title,
        chance,
        attempts: summary.attempts,
        accuracy: summary.attempts ? (summary.attempts - summary.wrong) / summary.attempts : null,
        notKnown: summary.total - summary.known,
      });
    }
    const chances = topics.map((t) => t.chance);
    return {
      pass: passProbability(chances, passScoreFor(chances.length)),
      expected: chances.reduce((sum, p) => sum + p, 0),
      topics: topics.slice().sort((a, b) => a.chance - b.chance),
    };
  }

  // --- Порядок вариантов ---

  const OPTION_REFERENCE = new RegExp(
    [
      '(вариант|ответ|утвержден)\\S*\\s+\\d', // «Варианты 1 и 2», «верны ответы 1 и 3»
      '\\d\\s*(и|или|и/или|,)\\s*\\d', // «верны 1 и 3 утверждения»
      '(все|всё)\\s.*(вариант|ответ|утвержден|перечисл|указанн)',
      'перечисленн|вышеуказанн|вышеприведенн|вышеприведённ',
      'нет\\s+(правильн|верн)',
      'оба\\s+(утвержд|вариант|ответ|требован)',
      'ни\\s+один\\s+из',
    ].join('|'),
    'i',
  );

  /** Вопрос можно перемешивать, только если варианты не ссылаются на другие варианты или их порядок. */
  function canShuffleOptions(question) {
    return !question.options.some((option) => OPTION_REFERENCE.test(option.text || ''));
  }

  /** Порядок показа: order[i] — индекс варианта, который показан на i-м месте. */
  function shuffleOrder(question, rng) {
    const indexes = question.options.map((_, i) => i);
    return canShuffleOptions(question) ? shuffle(indexes, rng) : indexes;
  }

  /** Сохранённый порядок вариантов, если он корректен, иначе исходный. */
  function normalizeOrder(order, size) {
    const identity = Array.from({ length: size }, (_, i) => i);
    if (!Array.isArray(order) || order.length !== size) return identity;
    return identity.every((i) => order.includes(i)) ? order : identity;
  }

  /** Пометки об ошибках в банке: { id: { note, at } }, только известные id. */
  function normalizeFlags(raw, knownIds) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [id, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object') continue;
      if (knownIds && !knownIds.has(id)) continue;
      out[id] = { note: typeof value.note === 'string' ? value.note : '', at: Number(value.at) || 0 };
    }
    return out;
  }

  /** Проценты для полосы прогресса внутри сессии. */
  function sessionProgress(state) {
    const total = state.initialCount || 0;
    const done = state.answeredCorrectIds ? state.answeredCorrectIds.length : 0;
    return total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  }

  // --- Режим экзамена ---

  /**
   * Параметры как на реальном тестировании 1С:Профессионал:
   * 14 вопросов (по одному из каждой темы), 30 минут, зачёт от 12 верных.
   */
  const EXAM = { durationSec: 30 * 60, passScore: 12, questionCount: 14 };

  /**
   * Вопрос ссылается на рисунок, а картинки к нему в банке нет — на экзамене его не даём.
   * Вопросы, где слово «картинка» — просто часть темы («редактор картинок»), сюда не попадают.
   */
  function needsImage(question) {
    if (question.image && question.image.src) return false;
    return /на рисунке|на картинке|рисунком/i.test(question.text || '');
  }

  /**
   * Билет: по одному случайному вопросу из каждой темы, в порядке тем.
   * byCategory — Map или объект { categoryId: [вопросы] }.
   */
  function buildExam(categories, byCategory, rng) {
    const random = rng || Math.random;
    const out = [];
    for (const category of categories || []) {
      const pool =
        (byCategory instanceof Map ? byCategory.get(category.id) : byCategory[category.id]) || [];
      const usable = pool.filter((q) => !needsImage(q));
      const source = usable.length ? usable : pool;
      if (!source.length) continue;
      out.push(source[Math.floor(random() * source.length)]);
    }
    return out;
  }

  /** Сколько верных нужно для зачёта при данном размере билета (12 из 14 — та же доля). */
  function passScoreFor(total) {
    if (total === EXAM.questionCount) return EXAM.passScore;
    return Math.ceil((total * EXAM.passScore) / EXAM.questionCount);
  }

  /** Итог экзамена. answers[i] — массив выбранных индексов для i-го вопроса. */
  function gradeExam(questions, answers) {
    let correct = 0;
    const items = questions.map((question, i) => {
      const selected = (answers && answers[i]) || [];
      const ok = selected.length > 0 && checkAnswer(question, selected);
      if (ok) correct += 1;
      return { id: question.id, selected: selected.slice(), answered: selected.length > 0, ok };
    });
    const need = passScoreFor(questions.length);
    return { total: questions.length, correct, need, passed: correct >= need, items };
  }

  /** 125 → «02:05». */
  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  return {
    EXAM,
    needsImage,
    buildExam,
    passScoreFor,
    gradeExam,
    formatTime,
    STORAGE_VERSION,
    correctIndexes,
    checkAnswer,
    shuffle,
    emptyProgress,
    normalizeProgress,
    normalizeFavorites,
    toggleFavorite,
    recordAnswer,
    statusOf,
    progressFor,
    buildQueue,
    sessionProgress,
    dayNumber,
    isDue,
    DAILY,
    buildDaily,
    answeredToday,
    passProbability,
    forecast,
    canShuffleOptions,
    shuffleOrder,
    normalizeOrder,
    normalizeFlags,
  };
});
