// ==UserScript==
// @name         Битрикс24 — Авторасстановка подписей
// @namespace    http://tampermonkey.net/
// @version      4.1
// @description  Находит строки "/ Имя" через OCR и ставит блоки подписей точно на их место
// @match        https://*.bitrix24.ru/*
// @grant        GM_setValue
// @grant        GM_getValue
// @require      https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js
// @updateURL    https://raw.githubusercontent.com/lab-vita/bitrix24-sign-autoplacement/main/script.user.js
// @downloadURL  https://raw.githubusercontent.com/lab-vita/bitrix24-sign-autoplacement/main/script.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ── Настройки ──────────────────────────────────────────────────────────
    const DEFAULT_CONFIG = {
        mySign:           { sectionIndex: 0, blockIndex: 2 },
        counterpartySign: { sectionIndex: 1, blockIndex: 2 },
    };

    let config = GM_getValue('signConfig_v4', DEFAULT_CONFIG);

    // ── Утилиты ────────────────────────────────────────────────────────────

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function waitFor(selector, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const el = document.querySelector(selector);
            if (el) return resolve(el);
            const obs = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) { obs.disconnect(); resolve(el); }
            });
            obs.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { obs.disconnect(); reject('Timeout: ' + selector); }, timeout);
        });
    }

    function setStatus(msg) {
        const el = document.getElementById('bx-autosign-status');
        if (el) el.textContent = msg;
        console.log('[AutoSign]', msg);
    }

    // ── OCR ────────────────────────────────────────────────────────────────

    // Страницы которые гарантированно без подписей (0-индексация: стр.1 = 0)
    const SKIP_PAGES = new Set([0, 2, 3, 4, 6]);

    // Для каждой проверяемой страницы указываем какую половину сканировать
    // 'top' = верхняя половина, 'bottom' = нижняя половина, 'full' = вся страница
    const PAGE_CROP = {
        1: 'top',    // страница 2
        5: 'top',    // страница 6
        7: 'bottom', // страница 8
        8: 'top',    // страница 9 (если подписи перелились)
    };

    // Обрезаем изображение до нужной половины
    function cropImage(imgSrc, half) {
        return new Promise(resolve => {
            if (half === 'full') { resolve(imgSrc); return; }
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = Math.floor(img.height / 2);
                const ctx = canvas.getContext('2d');
                const srcY = half === 'bottom' ? Math.floor(img.height / 2) : 0;
                ctx.drawImage(img, 0, srcY, img.width, canvas.height, 0, 0, img.width, canvas.height);
                resolve(canvas.toDataURL('image/png'));
            };
            img.src = imgSrc;
        });
    }

    // Найти все маркеры подписей — ищем отдельное слово "/"
    // р/с: и к/с: Tesseract читает слитно, поэтому они не попадают в результат
    // Возвращает: [ { pageIndex, isLeft, xPct, yPct } ]
    async function findAllMarkers(pages, worker) {
        const markers = [];
        const checkPages = pages.map((_, i) => i).filter(i => !SKIP_PAGES.has(i));

        for (const i of checkPages) {
            setStatus(`🔍 Анализирую страницу ${i + 1} (${checkPages.indexOf(i) + 1} из ${checkPages.length})...`);
            const img = pages[i].querySelector('img');
            if (!img) continue;

            const half = PAGE_CROP[i] || 'full';
            const cropSrc = await cropImage(img.src, half);
            // Смещение по Y если сканируем нижнюю половину
            const yOffset = half === 'bottom' ? 0.5 : 0;

            const { data } = await worker.recognize(cropSrc);
            const W = img.naturalWidth;
            const H = img.naturalHeight;

            // Ищем все слова длиной 1-2 символа, похожие на слеш (Tesseract путает / с 1, l, I, |)
            // Затем проверяем — справа от него на той же строке стоят инициалы "Х.Х." или "Х.Х. Фамилия"
            const SLASH_LIKE = /^[\/1lI|]{1,2}$/;
            const INITIALS_PATTERN = /^[А-ЯЁA-Z]\.?\s?[А-ЯЁA-Z]?\.?$/;

            for (let wi = 0; wi < data.words.length; wi++) {
                const w = data.words[wi];

                // Случай 1: явный слеш как отдельное слово или склеенный с буквой
                const isExplicitSlash = w.text === '/' || /^\/[А-ЯЁA-Z]/.test(w.text);

                // Случай 2: похожий на слеш символ (1, l, I, |) — короткое слово
                const isSlashLike = SLASH_LIKE.test(w.text) && w.text.length <= 2;

                if (!isExplicitSlash && !isSlashLike) continue;

                // Если это просто похожий символ — проверяем что следующее слово похоже на инициалы
                if (isSlashLike && !isExplicitSlash) {
                    const nextWord = data.words[wi + 1];
                    if (!nextWord) continue;
                    const sameLine = Math.abs(nextWord.bbox.y0 - w.bbox.y0) < 15;
                    const looksLikeInitials = INITIALS_PATTERN.test(nextWord.text) || /^[А-ЯЁA-Z]\.[А-ЯЁA-Z]\./.test(nextWord.text);
                    if (!sameLine || !looksLikeInitials) continue;
                }

                // Для склеенных "/М.В." берём левый край как позицию слеша
                const cx = w.text === '/' 
                    ? (w.bbox.x0 + w.bbox.x1) / 2 
                    : w.bbox.x0;
                const cy = (w.bbox.y0 + w.bbox.y1) / 2;

                // Левая или правая колонка — граница по середине страницы
                const isLeft = cx < W / 2;

                // Координаты в % от размера страницы
                // Если сканировали половину — cy относится к половине, пересчитываем
                const xPct = (cx / W) * 100;
                const yPct = yOffset * 100 + (cy / (H / 2)) * 50;

                // Блок ставим левее слеша — на середину линии _____
                // Линия обычно ~120px в PNG (≈10% ширины), отступаем на половину
                const SLASH_OFFSET_PCT = 8; // сдвиг влево от слеша в %
                const blockXPct = xPct - SLASH_OFFSET_PCT;

                markers.push({ pageIndex: i, isLeft, xPct: blockXPct, yPct });
                console.log(`[AutoSign] Стр.${i+1} ${isLeft ? 'ЛЕВАЯ' : 'ПРАВАЯ'} колонка: слеш=${xPct.toFixed(1)}% блок=${blockXPct.toFixed(1)}% y=${yPct.toFixed(1)}%`);
            }
        }

        return markers;
    }

    // ── Расстановка блоков ─────────────────────────────────────────────────

    function getContainer() {
        return document.querySelector('.sign-editor__document.ui-draggable--container');
    }

    function calcPosition(pageIndex, xPct, yPct) {
        const pages = document.querySelectorAll('.sign-editor__document_page');
        const page = pages[pageIndex];
        if (!page) return { left: 0, top: 0 };

        const img = page.querySelector('img');
        const pngW = img ? img.naturalWidth  : 1241;
        const pngH = img ? img.naturalHeight : 1754;
        const scale = (page.offsetWidth || 750) / pngW;
        const domPageH = Math.round(pngH * scale);

        let gap = 20;
        if (pages.length > 1) {
            const r0 = pages[0].getBoundingClientRect();
            const r1 = pages[1].getBoundingClientRect();
            gap = Math.round(r1.top - r0.bottom);
        }

        const pageOffsetTop = pageIndex * (domPageH + gap);
        const left = (pngW * xPct / 100) * scale - 75;
        const top  = pageOffsetTop + (pngH * yPct / 100) * scale - 25;

        console.log(`[AutoSign] calcPosition: pageIndex=${pageIndex} pageOffsetTop=${pageOffsetTop} scale=${scale.toFixed(3)} → left=${Math.round(left)} top=${Math.round(top)}`);
        return { left: Math.max(0, left), top: Math.max(0, top) };
    }

    function getAddButton(sectionIndex, blockIndex) {
        const sections = document.querySelectorAll('.sign-editor__section');
        if (!sections[sectionIndex]) return null;
        return sections[sectionIndex].querySelectorAll('.sign-editor__section_add-block-btn')[blockIndex] || null;
    }

    // Добавляет блок через кнопку "В документ" и сразу перехватывает позицию через MutationObserver
    function addAndPlaceBlock(sectionIndex, blockIndex, left, top) {
        return new Promise((resolve) => {
            const container = getContainer();
            if (!container) { resolve(null); return; }

            const obs = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    for (const node of m.addedNodes) {
                        if (node.classList?.contains('sign-document__block-wrapper')) {
                            obs.disconnect();
                            // Сразу выставляем нужную позицию
                            node.style.left   = left + 'px';
                            node.style.top    = top  + 'px';
                            node.style.width  = '150px';
                            node.style.height = '50px';
                            console.log(`[AutoSign] Блок перехвачен и размещён: left=${Math.round(left)} top=${Math.round(top)}`);
                            // Сохраняем через saveAction
                            setTimeout(() => {
                                node.querySelector('.sign-block-action-save')?.click();
                                resolve(node);
                            }, 100);
                            return;
                        }
                    }
                }
            });

            obs.observe(container, { childList: true });

            const btn = getAddButton(sectionIndex, blockIndex);
            if (!btn) { obs.disconnect(); resolve(null); return; }
            btn.click();

            // Таймаут на случай если блок не появился
            setTimeout(() => { obs.disconnect(); resolve(null); }, 3000);
        });
    }

    // ── Главная функция ────────────────────────────────────────────────────

    async function autoPlace() {
        const btn = document.getElementById('bx-autosign-btn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Работаю...'; }

        let worker = null;
        try {
            setStatus('🔍 Запускаю OCR...');
            const pages = Array.from(document.querySelectorAll('.sign-editor__document_page'));

            worker = await Tesseract.createWorker('rus', 1, {
                logger: m => {
                    if (m.status === 'recognizing text') {
                        setStatus(`🔍 Стр. ${m.jobId?.slice(-1) || '?'} — ${Math.round(m.progress * 100)}%`);
                    }
                }
            });

            const markers = await findAllMarkers(pages, worker);
            await worker.terminate();
            worker = null;

            if (markers.length === 0) {
                showToast('❌ Маркеры подписей не найдены');
                setStatus('❌ Маркеры не найдены');
                return;
            }

            // Группируем по страницам: на каждой странице ожидаем левый + правый маркер
            const byPage = {};
            markers.forEach(m => {
                if (!byPage[m.pageIndex]) byPage[m.pageIndex] = {};
                if (m.isLeft) byPage[m.pageIndex].left = m;
                else          byPage[m.pageIndex].right = m;
            });

            const pageIndexes = Object.keys(byPage).map(Number).sort((a, b) => a - b);
            setStatus(`✓ Найдены страницы: ${pageIndexes.map(i => i + 1).join(', ')}`);

            // Предупреждение если пар не 3
            if (pageIndexes.length !== 3) {
                const ok = confirm(
                    `Найдено страниц с подписями: ${pageIndexes.length} (ожидалось 3).\n` +
                    `Страницы: ${pageIndexes.map(i => i + 1).join(', ')}\n\n` +
                    `Продолжить расстановку?`
                );
                if (!ok) { setStatus('Отменено'); return; }
            }

            // Расставляем блоки через кнопку "В документ" + MutationObserver
            for (const pageIndex of pageIndexes) {
                const pair = byPage[pageIndex];
                setStatus(`✍️ Расставляю подписи на стр. ${pageIndex + 1}...`);

                // Ваша подпись — левая колонка
                if (pair.left) {
                    const { left, top } = calcPosition(pageIndex, pair.left.xPct, pair.left.yPct);
                    await addAndPlaceBlock(
                        config.mySign.sectionIndex,
                        config.mySign.blockIndex,
                        left, top
                    );
                    await sleep(200);
                }

                // Подпись контрагента — правая колонка
                if (pair.right) {
                    const { left, top } = calcPosition(pageIndex, pair.right.xPct, pair.right.yPct);
                    await addAndPlaceBlock(
                        config.counterpartySign.sectionIndex,
                        config.counterpartySign.blockIndex,
                        left, top
                    );
                    await sleep(200);
                }
            }

            setStatus(`✅ Готово — ${pageIndexes.length} × 2 подписи`);
            showToast(`✅ Расставлено на стр. ${pageIndexes.map(i => i + 1).join(', ')}`);

        } catch (e) {
            console.error('[AutoSign]', e);
            if (worker) { try { await worker.terminate(); } catch(_) {} }
            setStatus('❌ Ошибка: ' + e.message);
            showToast('❌ Ошибка: ' + e.message);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '✍️ Расставить подписи'; }
        }
    }

    // Настройки убраны — позиции вычисляются автоматически по координате слеша
    function openSettings() { showToast('Позиции определяются автоматически по линии подписи'); }

    function showToast(msg) {
        const t = document.createElement('div');
        t.textContent = msg;
        t.style.cssText = `
            position:fixed;bottom:30px;right:20px;z-index:99999;
            background:#323232;color:#fff;padding:10px 16px;
            border-radius:8px;font-family:sans-serif;font-size:13px;
            box-shadow:0 3px 10px rgba(0,0,0,.2);
        `;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 4000);
    }

    // ── Инъекция UI ────────────────────────────────────────────────────────

    async function injectButtons() {
        try {
            const header = await waitFor('.sign-editor__header_right');
            if (document.getElementById('bx-autosign-btn')) return;

            const statusEl = document.createElement('span');
            statusEl.id = 'bx-autosign-status';
            statusEl.style.cssText = `
                margin-right:10px;font-size:12px;color:#888;
                font-family:sans-serif;vertical-align:middle;
            `;

            const mainBtn = document.createElement('button');
            mainBtn.id = 'bx-autosign-btn';
            mainBtn.textContent = '✍️ Расставить подписи';
            mainBtn.style.cssText = `
                margin-right:8px;padding:4px 14px;
                border:none;border-radius:6px;
                background:#2196F3;color:#fff;
                cursor:pointer;font-size:13px;font-weight:500;
            `;
            mainBtn.onclick = autoPlace;

            header.insertBefore(statusEl, header.firstChild);
            header.insertBefore(mainBtn,  header.firstChild);

        } catch (e) {
            console.warn('[AutoSign] Не удалось вставить кнопки:', e);
        }
    }

    const observer = new MutationObserver(() => {
        if (document.querySelector('.sign-wizard__scope') && !document.getElementById('bx-autosign-btn')) {
            injectButtons();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    if (document.querySelector('.sign-wizard__scope')) injectButtons();

})();
