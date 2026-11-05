// Тесты чистой логики тренажёра (app-core.js). Запуск: node --test tools/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const Core = require('../app-core.js');

/** Детерминированный генератор для повторяемых тестов. */
function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const q = (id, correct, extra = {}) => ({
  id,
  text: `Вопрос ${id}`,
  options: [0, 1, 2].map((i) => ({ id: String(i), text: `вариант ${i}`, correct: correct.includes(i) })),
  multi: correct.length > 1,
  ...extra,
});

test('checkAnswer: одиночный и многоответный вопрос', () => {
  assert.equal(Core.checkAnswer(q('a', [1]), [1]), true);
  assert.equal(Core.checkAnswer(q('a', [1]), [0]), false);
  assert.equal(Core.checkAnswer(q('b', [0, 2]), [2, 0]), true);
  assert.equal(Core.checkAnswer(q('b', [0, 2]), [0]), false);
});

test('buildQueue: фильтр ошибок и новых', () => {
  const list = [q('a', [0]), q('b', [0]), q('c', [0])];
  const progress = Core.emptyProgress();
  Core.recordAnswer(progress, 'a', true, 1);
  Core.recordAnswer(progress, 'b', false, 1);
  assert.deepEqual(Core.buildQueue(list, progress, 'errors').map((x) => x.id), ['b']);
  assert.deepEqual(Core.buildQueue(list, progress, 'unknown').map((x) => x.id).sort(), ['b', 'c']);
});

test('buildExam: по одному вопросу из каждой темы, в порядке тем', () => {
  const categories = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }];
  const byCategory = new Map([
    ['c1', [q('c1-1', [0]), q('c1-2', [0])]],
    ['c2', [q('c2-1', [0])]],
    ['c3', [q('c3-1', [0]), q('c3-2', [0]), q('c3-3', [0])]],
  ]);
  const ticket = Core.buildExam(categories, byCategory, seeded(7));
  assert.equal(ticket.length, 3);
  assert.deepEqual(ticket.map((x) => x.id.slice(0, 2)), ['c1', 'c2', 'c3']);
});

test('buildExam: вопросы без нужной картинки не попадают в билет, если есть замена', () => {
  const categories = [{ id: 'c1' }, { id: 'c2' }];
  const byCategory = {
    c1: [q('pic', [0], { text: 'Что показано на рисунке?' }), q('plain', [0])],
    c2: [q('only-pic', [0], { text: 'На картинке представлено' })],
  };
  for (let seed = 1; seed < 30; seed += 1) {
    const ticket = Core.buildExam(categories, byCategory, seeded(seed));
    assert.equal(ticket[0].id, 'plain');
    assert.equal(ticket[1].id, 'only-pic'); // других вопросов в теме нет — берём что есть
  }
});

test('needsImage: вопрос с картинкой допускается, без картинки — нет', () => {
  assert.equal(Core.needsImage(q('a', [0], { text: 'Что показано на рисунке?' })), true);
  assert.equal(
    Core.needsImage(q('b', [0], { text: 'Что показано на рисунке?', image: { src: 'images/questions/b.webp', w: 10, h: 10 } })),
    false,
  );
  assert.equal(Core.needsImage(q('c', [0], { text: 'Изменить размер картинки в окне редактора картинок:' })), false);
});

test('gradeExam: 12 из 14 — сдано, 11 — нет, пропуск = ошибка', () => {
  const questions = Array.from({ length: 14 }, (_, i) => q(`q${i}`, [0]));
  const twelve = questions.map((_, i) => (i < 12 ? [0] : [1]));
  const r12 = Core.gradeExam(questions, twelve);
  assert.equal(r12.correct, 12);
  assert.equal(r12.need, 12);
  assert.equal(r12.passed, true);

  const eleven = questions.map((_, i) => (i < 11 ? [0] : []));
  const r11 = Core.gradeExam(questions, eleven);
  assert.equal(r11.correct, 11);
  assert.equal(r11.passed, false);
  assert.equal(r11.items.filter((x) => !x.answered).length, 3);
});

test('passScoreFor: та же доля 12/14 для неполного билета', () => {
  assert.equal(Core.passScoreFor(14), 12);
  assert.equal(Core.passScoreFor(7), 6);
});

test('объяснения: ключи совпадают с id вопросов, у каждого есть подсказка и объяснение', () => {
  const read = (file) => readFileSync(new URL(`../data/${file}`, import.meta.url), 'utf8');
  const bank = read('questions.js');
  const ids = new Set(JSON.parse(bank.slice(bank.indexOf('{'), bank.lastIndexOf('}') + 1)).questions.map((x) => x.id));
  const sandbox = {};
  new Function('window', read('explanations.js'))(sandbox);
  const entries = Object.entries(sandbox.EXAM_EXPLANATIONS);
  assert.ok(entries.length > 0);
  for (const [id, value] of entries) {
    assert.ok(ids.has(id), `нет вопроса ${id}`);
    assert.ok(value.h && value.e, `пустая подсказка или объяснение: ${id}`);
  }
});

test('разборы тем: ключи совпадают с темами банка, есть заголовок и текст', () => {
  const read = (file) => readFileSync(new URL(`../data/${file}`, import.meta.url), 'utf8');
  const bank = read('questions.js');
  const cats = new Set(JSON.parse(bank.slice(bank.indexOf('{'), bank.lastIndexOf('}') + 1)).categories.map((c) => c.id));
  const sandbox = {};
  const dir = new URL('../data/guides/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    new Function('window', readFileSync(new URL(file, dir), 'utf8'))(sandbox);
  }
  const entries = Object.entries(sandbox.EXAM_GUIDES);
  assert.equal(entries.length, cats.size, 'разбор есть для каждой темы');
  for (const [id, guide] of entries) {
    assert.ok(cats.has(id), `нет темы ${id}`);
    assert.ok(guide.title && guide.html.length > 1000, `пустой разбор: ${id}`);
  }
});

test('избранное: переключение, без повторов, неизвестные id отбрасываются', () => {
  let fav = [];
  fav = Core.toggleFavorite(fav, 'a');
  fav = Core.toggleFavorite(fav, 'b');
  assert.deepEqual(fav, ['a', 'b']);
  fav = Core.toggleFavorite(fav, 'a');
  assert.deepEqual(fav, ['b']);
  const known = new Map([['a', 1], ['b', 1]]);
  assert.deepEqual(Core.normalizeFavorites(['a', 'a', 'zzz', 5, 'b'], known), ['a', 'b']);
  assert.deepEqual(Core.normalizeFavorites({ favorites: ['b'] }), ['b']);
  assert.deepEqual(Core.normalizeFavorites(null), []);
});

test('formatTime', () => {
  assert.equal(Core.formatTime(0), '00:00');
  assert.equal(Core.formatTime(125), '02:05');
  assert.equal(Core.formatTime(30 * 60), '30:00');
  assert.equal(Core.formatTime(-5), '00:00');
});

test('банк вопросов: правильные ответы, картинки на месте, экзамен собирается на 14 тем', () => {
  const source = readFileSync(new URL('../data/questions.js', import.meta.url), 'utf8');
  const data = JSON.parse(source.slice(source.indexOf('{'), source.lastIndexOf('}') + 1));
  for (const question of data.questions) {
    assert.ok(Core.correctIndexes(question).length > 0, `нет правильного ответа: ${question.id}`);
  }
  const byCategory = new Map();
  for (const question of data.questions) {
    if (!byCategory.has(question.categoryId)) byCategory.set(question.categoryId, []);
    byCategory.get(question.categoryId).push(question);
  }
  for (const question of data.questions) {
    assert.ok(!Core.needsImage(question), `вопрос ссылается на рисунок, но картинки нет: ${question.id}`);
    if (question.image) {
      assert.ok(existsSync(new URL(`../${question.image.src}`, import.meta.url)), `нет файла ${question.image.src}`);
    }
  }
  const ticket = Core.buildExam(data.categories, byCategory, seeded(42));
  assert.equal(ticket.length, Core.EXAM.questionCount);
  assert.ok(ticket.every((x) => !Core.needsImage(x)));
});
