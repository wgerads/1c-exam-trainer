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
      out.questions[id] = {
        seen,
        correct,
        wrong,
        ok: value.ok === true,
        last: Number(value.last) || 0,
      };
    }
    return out;
  }

  function recordAnswer(progress, questionId, isCorrect, now) {
    const stamp = now || Date.now();
    const prev = progress.questions[questionId] || { seen: 0, correct: 0, wrong: 0, ok: false, last: 0 };
    progress.questions[questionId] = {
      seen: prev.seen + 1,
      correct: prev.correct + (isCorrect ? 1 : 0),
      wrong: prev.wrong + (isCorrect ? 0 : 1),
      ok: isCorrect,
      last: stamp,
    };
    return progress;
  }

  /** Статус вопроса по прогрессу: известен / с ошибкой / не начат. */
  function statusOf(question, progress) {
    const entry = progress.questions ? progress.questions[question.id] : null;
    if (!entry || entry.seen === 0) return 'untouched';
    return entry.ok ? 'known' : 'error';
  }

  /** Сводка по списку вопросов: всего / изучено / с ошибками / не начато. */
  function progressFor(questions, progress) {
    const summary = { total: questions.length, known: 0, errors: 0, untouched: 0, attempts: 0, wrong: 0 };
    for (const question of questions) {
      const entry = progress.questions ? progress.questions[question.id] : null;
      if (entry) {
        summary.attempts += entry.seen;
        summary.wrong += entry.wrong;
      }
      const status = statusOf(question, progress);
      if (status === 'known') summary.known += 1;
      else if (status === 'error') summary.errors += 1;
      else summary.untouched += 1;
    }
    summary.percent = summary.total ? Math.round((summary.known / summary.total) * 100) : 0;
    return summary;
  }

  /**
   * Очередь сессии.
   * mode: 'all' — все вопросы; 'unknown' — неизученные; 'errors' — только с ошибками.
   */
  function buildQueue(questions, progress, mode, rng) {
    let list = questions.slice();
    if (mode === 'unknown') list = list.filter((q) => statusOf(q, progress) !== 'known');
    else if (mode === 'errors') list = list.filter((q) => statusOf(q, progress) === 'error');
    return shuffle(list, rng);
  }

  /** Проценты для полосы прогресса внутри сессии. */
  function sessionProgress(state) {
    const total = state.initialCount || 0;
    const done = state.answeredCorrectIds ? state.answeredCorrectIds.length : 0;
    return total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  }

  return {
    STORAGE_VERSION,
    correctIndexes,
    checkAnswer,
    shuffle,
    emptyProgress,
    normalizeProgress,
    recordAnswer,
    statusOf,
    progressFor,
    buildQueue,
    sessionProgress,
  };
});
