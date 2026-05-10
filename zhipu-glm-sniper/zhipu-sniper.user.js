// ==UserScript==
// @name         智谱GLM Coding抢购助手 v3.2
// @namespace    http://tampermonkey.net/
// @version      3.2
// @description  自动抢购智谱GLM Coding套餐，到点自动打开页面并高速监控，辅助完成到确认前
// @author       codex-rag
// @match        https://bigmodel.cn/glm-coding*
// @match        https://www.bigmodel.cn/glm-coding*
// @match        https://open.bigmodel.cn/glm-coding*
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ==================== 配置区 ====================
    const DEFAULT_CONFIG = {
        // --- 开售时间 ---
        dailyMode: true,           // 每天固定时间开售
        dailySaleTime: '10:00:00', // 每天开售时间
        saleTime: '',              // 单次开售时间: '2026-05-15 10:00:00'，dailyMode=false 时使用
        preStartMin: 3,            // 提前几分钟开始运行监控
        autoRefreshOnSale: true,   // 到点自动刷新页面
        preRefreshSec: 3,          // 提前几秒刷新（抢跑）

        // --- 目标套餐 ---
        targetPlan: 'Pro',         // 目标套餐: Lite / Pro / Max
        billingCycle: 'monthly',   // 计费周期: monthly / quarterly / yearly

        // --- 自动抢购 ---
        autoClick: true,           // 检测到按钮可点时自动点击
        retryOnBusy: true,         // "抢购人数过多"时自动重试
        retryInterval: 500,        // 重试间隔(ms)
        maxRetry: 0,               // 最大重试次数，0=无限

        // --- 监控 ---
        checkInterval: 300,        // 正常监控间隔(ms)
        fastInterval: 100,         // 开售时加速间隔(ms)

        // --- 页面 URL ---
        pageUrl: 'https://bigmodel.cn/glm-coding',
    };

    let CONFIG = { ...DEFAULT_CONFIG };

    // ==================== 状态 ====================
    let state = {
        running: false,
        timer: null,
        phase: 'idle',         // idle / waiting / monitoring / triggered / retrying
        saleTimer: null,
        retryCount: 0,
        lastStatus: null,
        buttonState: 'unknown', // unknown / busy / available / disabled
        hasClicked: false,
        retryTimer: null,
    };

    // ==================== 工具函数 ====================
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

    function ts() {
        return new Date().toLocaleTimeString('zh-CN', { hour12: false });
    }

    // ==================== 音效系统 ====================
    const Audio = {
        ctx: null,
        getCtx() {
            if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            return this.ctx;
        },
        alert() {
            const ctx = this.getCtx();
            [800, 1000, 1200, 1500].forEach((f, i) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.frequency.value = f;
                osc.type = 'sine';
                gain.gain.setValueAtTime(0.4, ctx.currentTime + i * 0.15);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + i * 0.15 + 0.12);
                osc.start(ctx.currentTime + i * 0.15);
                osc.stop(ctx.currentTime + i * 0.15 + 0.15);
            });
        },
        urgent() {
            const ctx = this.getCtx();
            for (let i = 0; i < 8; i++) {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.frequency.value = i % 2 === 0 ? 1200 : 1600;
                osc.type = 'square';
                gain.gain.setValueAtTime(0.35, ctx.currentTime + i * 0.06);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + i * 0.06 + 0.05);
                osc.start(ctx.currentTime + i * 0.06);
                osc.stop(ctx.currentTime + i * 0.06 + 0.06);
            }
        },
        tick() {
            const ctx = this.getCtx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = 600;
            osc.type = 'sine';
            gain.gain.setValueAtTime(0.15, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
            osc.start();
            osc.stop(ctx.currentTime + 0.1);
        },
    };

    // ==================== 通知系统 ====================
    function notify(title, body, urgent = false) {
        if (Notification.permission === 'granted') {
            new Notification(title, { body, icon: '🚨' });
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(p => {
                if (p === 'granted') new Notification(title, { body });
            });
        }
        try {
            GM_notification({ title, text: body, timeout: urgent ? 30000 : 10000, onclick: () => window.focus() });
        } catch (e) { /* ignore */ }
        urgent ? Audio.urgent() : Audio.alert();
        showAlert(title, body, urgent);
    }

    function showAlert(title, body, urgent = false) {
        const existing = document.getElementById('sniper-alert-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'sniper-alert-overlay';
        overlay.innerHTML = `
            <div class="sniper-alert-box" style="border: 3px solid ${urgent ? '#ff4757' : '#667eea'}">
                <div style="font-size: 48px; margin-bottom: 16px;">${urgent ? '🚨' : '🔔'}</div>
                <h2 style="margin: 0 0 12px; color: #222; font-size: 20px;">${title}</h2>
                <p style="color: #555; margin: 0 0 24px; font-size: 14px; line-height: 1.5; white-space: pre-line;">${body}</p>
                <button class="sniper-alert-ok">我知道了</button>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('.sniper-alert-ok').onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
        if (urgent) setTimeout(() => window.focus(), 500);
    }

    // ==================== 日志 ====================
    function log(msg, type = 'info') {
        const logEl = document.getElementById('sniper-log');
        if (!logEl) return;
        const colors = { info: '#aaa', success: '#2ed573', warn: '#ffa502', error: '#ff4757', retry: '#a29bfe' };
        const line = document.createElement('div');
        line.style.color = colors[type] || colors.info;
        line.textContent = `[${ts()}] ${msg}`;
        logEl.prepend(line);
        while (logEl.children.length > 150) logEl.removeChild(logEl.lastChild);
    }

    // ==================== GLM Coding 页面检测 ====================

    // 计费周期映射
    const CYCLE_LABELS = {
        monthly: '连续包月',
        quarterly: '连续包季',
        yearly: '连续包年',
    };

    // 套餐名称映射
    const PLAN_NAMES = {
        lite: 'Lite',
        pro: 'Pro',
        max: 'Max',
        Lite: 'Lite',
        Pro: 'Pro',
        Max: 'Max',
    };

    // 不可购买关键词
    const BUSY_KEYWORDS = ['抢购人数过多', '请刷新再试', '抢购中', '系统繁忙'];
    const SOLD_OUT_KEYWORDS = ['已售罄', '售罄', '已结束', '已抢光', '暂无'];
    const BUY_KEYWORDS = ['购买', '立即购买', '抢购', '立即', '订阅', '开通'];

    function normalizePlanName(value) {
        const plan = String(value || '').trim().toLowerCase();
        return PLAN_NAMES[plan] || 'Pro';
    }

    function getTargetPlanName() {
        CONFIG.targetPlan = normalizePlanName(CONFIG.targetPlan);
        return CONFIG.targetPlan;
    }

    function getClassText(el) {
        if (!el || !el.className) return '';
        if (typeof el.className === 'string') return el.className;
        return el.className.baseVal || String(el.className);
    }

    function normalizeSaleTime(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const normalized = raw.replace('T', ' ');
        return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(normalized)
            ? normalized + ':00'
            : normalized;
    }

    function normalizeDailySaleTime(value) {
        const raw = String(value || '').trim();
        if (!raw) return '10:00:00';
        if (/^\d{1,2}:\d{2}$/.test(raw)) return raw.padStart(5, '0') + ':00';
        if (/^\d{1,2}:\d{2}:\d{2}$/.test(raw)) {
            const [h, m, s] = raw.split(':');
            return `${h.padStart(2, '0')}:${m}:${s}`;
        }
        return '10:00:00';
    }

    function getSaleInfo(now = new Date()) {
        if (!CONFIG.dailyMode) {
            const normalized = normalizeSaleTime(CONFIG.saleTime);
            const ts = new Date(normalized).getTime();
            return {
                ts,
                label: normalized,
                key: normalized || 'manual',
                recurring: false,
            };
        }

        CONFIG.dailySaleTime = normalizeDailySaleTime(CONFIG.dailySaleTime);
        const [h, m, s] = CONFIG.dailySaleTime.split(':').map(Number);
        const saleDate = new Date(now);
        saleDate.setHours(h, m, s || 0, 0);

        const lateWindowMs = 5 * 60 * 1000;
        if (now.getTime() - saleDate.getTime() > lateWindowMs) {
            saleDate.setDate(saleDate.getDate() + 1);
        }

        const dateText = saleDate.toLocaleDateString('zh-CN');
        return {
            ts: saleDate.getTime(),
            label: `每天 ${CONFIG.dailySaleTime}（下一次：${dateText}）`,
            key: `${saleDate.getFullYear()}-${String(saleDate.getMonth() + 1).padStart(2, '0')}-${String(saleDate.getDate()).padStart(2, '0')} ${CONFIG.dailySaleTime}`,
            recurring: true,
        };
    }

    function getSaleReloadKey() {
        const sale = getSaleInfo();
        return `sniper_sale_reloaded_${sale.key || 'manual'}`;
    }

    function hasReloadedForSale() {
        try {
            return sessionStorage.getItem(getSaleReloadKey()) === '1';
        } catch (e) {
            return false;
        }
    }

    function markReloadedForSale() {
        try {
            sessionStorage.setItem(getSaleReloadKey(), '1');
        } catch (e) { /* ignore */ }
    }

    function findPlanCards() {
        const cards = [];
        // 策略1: 通过价格元素 (¥) 定位卡片
        const allElements = $$('*');
        for (const el of allElements) {
            const text = (el.textContent || '').trim();
            // 匹配套餐卡片: 包含套餐名 + 价格
            if (text.includes('Lite') || text.includes('Pro') || text.includes('Max')) {
                // 检查是否是卡片级别元素（有按钮或价格在里面）
                const btns = el.querySelectorAll('button, [role="button"]');
                const hasPrice = text.includes('¥');
                if (btns.length > 0 && hasPrice && el.getBoundingClientRect().height > 100) {
                    // 提取套餐名
                    let planName = '';
                    if (text.includes('Max')) planName = 'Max';
                    else if (text.includes('Pro')) planName = 'Pro';
                    else if (text.includes('Lite')) planName = 'Lite';

                    if (planName) {
                        cards.push({ el, planName, buttons: [...btns], text });
                    }
                }
            }
        }

        // 去重: 如果一个元素是另一个的子级，只保留最内层
        const unique = cards.filter((card, i) => {
            return !cards.some((other, j) => i !== j && card.el.contains(other.el));
        });

        return unique;
    }

    function findBillingTabs() {
        const tabs = [];
        const allEls = $$('button, [role="tab"], [role="button"], div[class*="tab"], span[class*="tab"]');
        for (const el of allEls) {
            const text = (el.textContent || '').trim();
            if (text.includes('连续包月') || text.includes('连续包季') || text.includes('连续包年')) {
                tabs.push({ el, text });
            }
        }
        return tabs;
    }

    function getButtonState(btn) {
        const text = (btn.textContent || '').trim();
        const disabled = btn.disabled || btn.getAttribute('disabled') !== null;
        const ariaDisabled = btn.getAttribute('aria-disabled') === 'true';
        const classText = getClassText(btn);
        const hasBusyClass = classText.includes('disabled') || classText.includes('loading');

        if (disabled || ariaDisabled || hasBusyClass) {
            if (BUSY_KEYWORDS.some(k => text.includes(k))) return 'busy';
            return 'disabled';
        }
        if (BUSY_KEYWORDS.some(k => text.includes(k))) return 'busy';
        if (SOLD_OUT_KEYWORDS.some(k => text.includes(k))) return 'soldout';
        if (BUY_KEYWORDS.some(k => text.includes(k))) return 'available';
        return 'unknown';
    }

    function getPageStatus() {
        const cards = findPlanCards();
        const tabs = findBillingTabs();
        // 找到目标套餐卡片
        const targetPlanUpper = getTargetPlanName();
        const targetCard = cards.find(c => c.planName === targetPlanUpper);

        let targetButton = null;
        let buttonState = 'no_card';
        let buttonText = '';

        if (targetCard) {
            // 找到该卡片里最适合的按钮
            for (const btn of targetCard.buttons) {
                const state = getButtonState(btn);
                if (state === 'available') {
                    targetButton = btn;
                    buttonState = 'available';
                    buttonText = btn.textContent.trim();
                    break;
                }
                if (state === 'busy' && !targetButton) {
                    targetButton = btn;
                    buttonState = 'busy';
                    buttonText = btn.textContent.trim();
                }
                if (state === 'disabled' && !targetButton) {
                    targetButton = btn;
                    buttonState = 'disabled';
                    buttonText = btn.textContent.trim();
                }
            }
            if (!targetButton && targetCard.buttons.length > 0) {
                targetButton = targetCard.buttons[0];
                buttonText = targetCard.buttons[0].textContent.trim();
                buttonState = getButtonState(targetCard.buttons[0]);
            }
        }

        return {
            timestamp: Date.now(),
            cards: cards.map(c => ({ plan: c.planName, buttonCount: c.buttons.length })),
            tabs: tabs.map(t => t.text),
            targetCard: targetCard ? targetCard.planName : null,
            targetButton,
            buttonState,
            buttonText,
            url: location.href,
        };
    }

    function settleAfterClick() {
        state.phase = 'triggered';
        state.running = false;
        if (state.timer) clearInterval(state.timer);
        if (state.retryTimer) {
            clearTimeout(state.retryTimer);
            state.retryTimer = null;
        }
        if (observer) { observer.disconnect(); observer = null; }

        const btn = document.getElementById('btn-start');
        const statusEl = document.getElementById('sniper-status');
        if (btn) {
            btn.textContent = '已点击';
            btn.disabled = true;
        }
        if (statusEl) {
            statusEl.textContent = '已点击';
            statusEl.className = 'sniper-badge waiting';
        }
    }

    function scheduleBusyRetry(status) {
        if (!CONFIG.retryOnBusy || state.retryTimer) return;

        if (CONFIG.maxRetry > 0 && state.retryCount >= CONFIG.maxRetry) {
            log(`达到最大重试次数 ${CONFIG.maxRetry}，停止重试`, 'error');
            stopMonitor();
            return;
        }

        const delay = Math.max(100, parseInt(CONFIG.retryInterval, 10) || 500);
        log(`页面提示"${status.buttonText || '抢购繁忙'}"，${delay}ms 后刷新重试`, 'retry');
        state.retryTimer = setTimeout(() => {
            state.retryTimer = null;
            if (!state.running || state.phase === 'triggered') return;
            location.reload();
        }, delay);
    }

    // ==================== 操作 ====================

    function selectBillingTab() {
        const targetLabel = CYCLE_LABELS[CONFIG.billingCycle];
        if (!targetLabel) return false;

        const tabs = findBillingTabs();
        for (const tab of tabs) {
            if (tab.text.includes(targetLabel)) {
                // 检查是否已选中（通过 class 或 aria 属性）
                const isActive = tab.el.classList.contains('active') ||
                    tab.el.classList.contains('selected') ||
                    tab.el.getAttribute('aria-selected') === 'true' ||
                    tab.el.style.fontWeight === 'bold';

                if (!isActive) {
                    tab.el.click();
                    log(`已切换到: ${targetLabel}`, 'success');
                    return true;
                }
                return false; // 已经选中
            }
        }
        return false;
    }

    function clickBuyButton() {
        if (!state.lastStatus || !state.lastStatus.targetButton) return false;
        if (state.hasClicked) return false;

        const btn = state.lastStatus.targetButton;
        const text = btn.textContent.trim();
        state.hasClicked = true;

        log(`尝试点击: "${text}"`, 'info');
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // 高亮
        btn.style.outline = '4px solid #ff4757';
        btn.style.outlineOffset = '4px';
        btn.style.animation = 'sniper-pulse 0.5s infinite';

        // 点击
        btn.click();
        log('已点击购买按钮', 'success');
        return true;
    }

    // ==================== 主监控循环 ====================
    function monitor() {
        const status = getPageStatus();
        state.lastStatus = status;
        state.buttonState = status.buttonState;

        updateStatusDisplay(status);

        const { buttonState, targetCard } = status;

        if (state.phase === 'triggered' || state.hasClicked) {
            return;
        }

        // 没找到目标卡片
        if (!targetCard) {
            if (state.retryCount % 20 === 0) {
                log('未找到目标套餐卡片，等待页面加载...', 'warn');
            }
            state.retryCount++;
            return;
        }

        // 按钮可购买
        if (buttonState === 'available') {
            log(`🟢 按钮可购买！状态: "${status.buttonText}"`, 'success');

            if (CONFIG.autoClick) {
                const clicked = clickBuyButton();
                if (!clicked) return;
                notify(
                    '抢购成功！',
                    `${getTargetPlanName()} 套餐按钮已点击\n请检查订单并手动确认`,
                    true
                );
                settleAfterClick();
            } else {
                notify(
                    '可以购买了！',
                    `${getTargetPlanName()} 套餐按钮已激活\n请手动点击购买`,
                    true
                );
                highlightElement(status.targetButton);
                stopMonitor();
            }
            return;
        }

        // 按钮繁忙 (抢购人数过多)
        if (buttonState === 'busy') {
            if (state.phase !== 'retrying') {
                state.phase = 'retrying';
                state.retryCount = 0;
                log(`⏳ ${status.buttonText}`, 'warn');
            }
            state.retryCount++;

            if (CONFIG.retryOnBusy) {
                if (state.retryCount % 5 === 0) {
                    log(`重试中... (${state.retryCount})`, 'retry');
                }
                scheduleBusyRetry(status);
            }
            return;
        }

        // 按钮禁用
        if (buttonState === 'disabled') {
            if (state.retryCount % 30 === 0) {
                log('按钮当前不可用，持续监控...', 'info');
            }
            state.retryCount++;
        }
    }

    function highlightElement(el) {
        el.style.outline = '4px solid #ff4757';
        el.style.outlineOffset = '4px';
        el.style.animation = 'sniper-pulse 1s infinite';
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // ==================== 定时开售系统 ====================
    function initSaleTimer() {
        if (!CONFIG.dailyMode && !CONFIG.saleTime) {
            log('未设置开售时间，需手动启动', 'info');
            return;
        }

        const sale = getSaleInfo();
        if (isNaN(sale.ts)) {
            log('开售时间格式错误: ' + (CONFIG.dailyMode ? CONFIG.dailySaleTime : CONFIG.saleTime), 'error');
            return;
        }

        state.phase = 'waiting';
        log(`开售时间: ${sale.label}`, 'info');

        const countdown = () => {
            const now = Date.now();
            const currentSale = getSaleInfo(new Date());
            const diff = currentSale.ts - now;

            if (diff <= 0) {
                clearInterval(state.saleTimer);
                onSaleTime();
                return;
            }

            const sec = Math.ceil(diff / 1000);
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            const s = sec % 60;
            const display = h > 0 ? `${h}时${m}分${s}秒` : m > 0 ? `${m}分${s}秒` : `${s}秒`;

            const cdEl = document.getElementById('sniper-countdown');
            if (cdEl) cdEl.textContent = `距离开售: ${display}`;

            const preStartMs = Math.max(0, parseInt(CONFIG.preStartMin, 10) || 0) * 60 * 1000;
            if (preStartMs > 0 && diff <= preStartMs && !state.running) {
                log(`距离开售不足 ${CONFIG.preStartMin} 分钟，提前启动监控`, 'success');
                startMonitor();
            }

            // 最后 10 秒每秒滴一声
            if (sec <= 10) Audio.tick();

            // 提前刷新
            if (CONFIG.autoRefreshOnSale && sec === CONFIG.preRefreshSec) {
                log(`提前 ${CONFIG.preRefreshSec} 秒刷新页面...`, 'warn');
                location.reload();
            }
        };

        countdown();
        state.saleTimer = setInterval(countdown, 1000);
    }

    function onSaleTime() {
        log('⏰ 开售时间到！', 'success');
        state.phase = 'monitoring';

        if (CONFIG.autoRefreshOnSale && !hasReloadedForSale()) {
            markReloadedForSale();
            log('自动刷新页面...', 'warn');
            location.reload();
            return;
        }

        window.focus();
        notify('开售了！', `开始抢购 ${getTargetPlanName()} 套餐`, true);

        if (!state.running) {
            startMonitor();
        }
    }

    // ==================== 监控控制 ====================
    function startMonitor() {
        if (state.running) return;
        state.running = true;
        state.retryCount = 0;
        state.hasClicked = false;
        if (state.retryTimer) {
            clearTimeout(state.retryTimer);
            state.retryTimer = null;
        }

        const btn = document.getElementById('btn-start');
        const statusEl = document.getElementById('sniper-status');
        if (btn) btn.textContent = '监控中...';
        if (btn) btn.disabled = true;
        if (statusEl) {
            statusEl.textContent = '监控中';
            statusEl.className = 'sniper-badge running';
        }

        log(`开始监控 ${getTargetPlanName()} 套餐...`, 'success');

        // 先切换到正确的计费周期
        selectBillingTab();

        // 立即检查
        monitor();
        if (!state.running) return;

        // 定时检查
        state.timer = setInterval(monitor, CONFIG.checkInterval);

        // MutationObserver
        startObserver();
    }

    function stopMonitor() {
        if (!state.running) return;
        state.running = false;

        if (state.timer) clearInterval(state.timer);
        if (state.retryTimer) {
            clearTimeout(state.retryTimer);
            state.retryTimer = null;
        }
        if (observer) { observer.disconnect(); observer = null; }

        const btn = document.getElementById('btn-start');
        const statusEl = document.getElementById('sniper-status');
        if (btn) btn.textContent = '开始监控';
        if (btn) btn.disabled = false;
        if (statusEl) {
            statusEl.textContent = '已停止';
            statusEl.className = 'sniper-badge stopped';
        }

        log('监控已停止');
    }

    // ==================== MutationObserver ====================
    let observer = null;

    function startObserver() {
        if (observer) observer.disconnect();

        observer = new MutationObserver(() => {
            clearTimeout(observer._debounce);
            observer._debounce = setTimeout(() => {
                if (state.running) monitor();
            }, 50);
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['disabled', 'class', 'style'],
        });
    }

    // ==================== 状态显示 ====================
    function updateStatusDisplay(status) {
        const cdEl = document.getElementById('sniper-countdown');
        if (!cdEl || state.phase === 'waiting') return;

        const stateMap = {
            available: '🟢 可购买',
            busy: '🟡 抢购中',
            disabled: '🔴 未开放',
            soldout: '⚫ 已售罄',
            no_card: '❓ 未找到卡片',
            unknown: '⚪ 未知',
        };

        cdEl.textContent = `目标: ${getTargetPlanName()} | 状态: ${stateMap[status.buttonState] || status.buttonState}`;
    }

    // ==================== UI 面板 ====================
    function createPanel() {
        GM_addStyle(`
            @keyframes sniper-pulse {
                0%, 100% { box-shadow: 0 0 0 0 rgba(255, 71, 87, 0.7); }
                50% { box-shadow: 0 0 20px 10px rgba(255, 71, 87, 0.3); }
            }
            .sniper-panel {
                position: fixed;
                top: 20px;
                right: 20px;
                width: 340px;
                background: #1a1a2e;
                border-radius: 16px;
                padding: 0;
                color: #eee;
                font-family: 'Microsoft YaHei', 'Segoe UI', sans-serif;
                box-shadow: 0 10px 50px rgba(0,0,0,0.5);
                z-index: 99999;
                user-select: none;
                overflow: hidden;
                transition: opacity 0.3s;
            }
            .sniper-panel.minimized { width: 56px; height: 56px; border-radius: 50%; cursor: pointer; }
            .sniper-panel.minimized .sniper-body { display: none; }
            .sniper-panel.minimized .sniper-header { padding: 16px; justify-content: center; }
            .sniper-panel.minimized .sniper-header h3,
            .sniper-panel.minimized .sniper-header .sniper-badge,
            .sniper-panel.minimized .sniper-header .sniper-minimize { display: none; }
            .sniper-panel.minimized .sniper-header::after { content: '🎯'; font-size: 22px; }
            .sniper-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 16px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                cursor: move;
            }
            .sniper-header h3 { margin: 0; font-size: 14px; font-weight: 600; }
            .sniper-badge {
                padding: 3px 10px;
                border-radius: 12px;
                font-size: 11px;
                font-weight: 600;
            }
            .sniper-badge.stopped { background: #555; }
            .sniper-badge.running { background: #2ed573; animation: sniper-pulse 2s infinite; }
            .sniper-badge.waiting { background: #ffa502; }
            .sniper-body { padding: 12px 16px; }
            .sniper-countdown {
                font-size: 13px;
                color: #aaa;
                margin-bottom: 8px;
                min-height: 20px;
            }
            .sniper-log {
                background: #0f0f23;
                border-radius: 8px;
                padding: 8px;
                height: 100px;
                overflow-y: auto;
                font-size: 11px;
                font-family: 'Cascadia Code', 'Consolas', monospace;
                line-height: 1.5;
                margin-bottom: 10px;
            }
            .sniper-log::-webkit-scrollbar { width: 4px; }
            .sniper-log::-webkit-scrollbar-thumb { background: #444; border-radius: 2px; }
            .sniper-btns { display: flex; gap: 6px; margin-bottom: 8px; }
            .sniper-btn {
                flex: 1;
                padding: 8px 0;
                border: none;
                border-radius: 8px;
                font-weight: 600;
                font-size: 12px;
                cursor: pointer;
                transition: all 0.2s;
                color: white;
            }
            .sniper-btn:hover { filter: brightness(1.1); transform: translateY(-1px); }
            .sniper-btn:active { transform: translateY(0); }
            .sniper-btn.start { background: #2ed573; }
            .sniper-btn.stop { background: #ff4757; }
            .sniper-btn.config { background: #5352ed; }
            .sniper-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
            .sniper-footer {
                font-size: 10px;
                color: #555;
                text-align: center;
                padding: 4px 16px 10px;
                border-top: 1px solid #222;
            }
            .sniper-minimize {
                background: none;
                border: none;
                color: white;
                font-size: 16px;
                cursor: pointer;
                padding: 0 4px;
                opacity: 0.7;
            }
            .sniper-minimize:hover { opacity: 1; }
            .sniper-alert-overlay {
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0,0,0,0.75);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 999999;
                animation: fadeIn 0.2s;
            }
            @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
            .sniper-alert-box {
                background: white;
                border-radius: 16px;
                padding: 36px 40px;
                max-width: 420px;
                text-align: center;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            }
            .sniper-alert-ok {
                padding: 10px 36px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                border: none;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
            }
            .sniper-alert-ok:hover { filter: brightness(1.1); }
            .sniper-config-overlay {
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0,0,0,0.6);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 999998;
            }
            .sniper-config-box {
                background: #1a1a2e;
                border-radius: 16px;
                padding: 24px;
                width: 400px;
                max-height: 80vh;
                overflow-y: auto;
                color: #eee;
            }
            .sniper-config-box h3 { margin: 0 0 16px; font-size: 16px; color: #667eea; }
            .sniper-config-box label {
                display: block;
                font-size: 12px;
                color: #888;
                margin: 10px 0 4px;
            }
            .sniper-config-box input, .sniper-config-box select {
                width: 100%;
                padding: 8px 12px;
                border: 1px solid #333;
                border-radius: 6px;
                background: #0f0f23;
                color: #eee;
                font-size: 13px;
                box-sizing: border-box;
            }
            .sniper-config-box input:focus, .sniper-config-box select:focus {
                outline: none;
                border-color: #667eea;
            }
            .sniper-config-box select { cursor: pointer; }
            .sniper-config-box select option { background: #0f0f23; color: #eee; }
            .sniper-config-actions {
                display: flex;
                gap: 10px;
                margin-top: 18px;
            }
            .sniper-config-actions button {
                flex: 1;
                padding: 10px;
                border: none;
                border-radius: 8px;
                font-weight: 600;
                cursor: pointer;
            }
            .sniper-config-actions .save { background: #2ed573; color: white; }
            .sniper-config-actions .cancel { background: #333; color: #aaa; }
        `);

        const panel = document.createElement('div');
        panel.className = 'sniper-panel';
        panel.id = 'sniper-panel';
        panel.innerHTML = `
            <div class="sniper-header" id="sniper-drag-handle">
                <h3>GLM 抢购</h3>
                <span class="sniper-badge stopped" id="sniper-status">未启动</span>
                <button class="sniper-minimize" id="sniper-minimize" title="最小化">—</button>
            </div>
            <div class="sniper-body">
                <div class="sniper-countdown" id="sniper-countdown">
                    ${CONFIG.dailyMode ? `每天开售: ${normalizeDailySaleTime(CONFIG.dailySaleTime)}` : (CONFIG.saleTime ? `开售: ${CONFIG.saleTime}` : '未设定开售时间')}
                </div>
                <div class="sniper-log" id="sniper-log"></div>
                <div class="sniper-btns">
                    <button class="sniper-btn start" id="btn-start">开始监控</button>
                    <button class="sniper-btn stop" id="btn-stop">停止</button>
                    <button class="sniper-btn config" id="btn-config">设置</button>
                </div>
            </div>
            <div class="sniper-footer">
                停在确认订单前 | Ctrl+Shift+S 启停
            </div>
        `;
        document.body.appendChild(panel);

        // 拖拽
        makeDraggable(panel, document.getElementById('sniper-drag-handle'));

        // 最小化
        document.getElementById('sniper-minimize').onclick = (e) => {
            e.stopPropagation();
            panel.classList.toggle('minimized');
        };
        panel.querySelector('.sniper-header').addEventListener('dblclick', () => {
            panel.classList.toggle('minimized');
        });
        panel.addEventListener('click', () => {
            if (panel.classList.contains('minimized')) panel.classList.remove('minimized');
        });

        // 按钮
        document.getElementById('btn-start').onclick = () => startMonitor();
        document.getElementById('btn-stop').onclick = () => stopMonitor();
        document.getElementById('btn-config').onclick = () => showConfigPanel();

        // 快捷键
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.shiftKey && e.key === 'S') {
                e.preventDefault();
                state.running ? stopMonitor() : startMonitor();
            }
            if (e.ctrlKey && e.shiftKey && e.key === 'H') {
                e.preventDefault();
                panel.classList.toggle('minimized');
            }
        });

        // Tampermonkey 菜单
        try {
            GM_registerMenuCommand('开始/停止监控', () => {
                state.running ? stopMonitor() : startMonitor();
            });
            GM_registerMenuCommand('打开设置', () => showConfigPanel());
        } catch (e) { /* ignore */ }
    }

    // ==================== 配置面板 ====================
    function showConfigPanel() {
        const existing = document.querySelector('.sniper-config-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'sniper-config-overlay';
        overlay.innerHTML = `
            <div class="sniper-config-box">
                <h3>GLM Coding 抢购设置</h3>

                <label>
                    <input type="checkbox" id="cfg-daily-mode" ${CONFIG.dailyMode ? 'checked' : ''}>
                    每天固定时间开售
                </label>

                <label>每天开售时间</label>
                <input type="time" id="cfg-daily-time" step="1"
                    value="${normalizeDailySaleTime(CONFIG.dailySaleTime)}">

                <label>提前运行分钟数</label>
                <input type="number" id="cfg-prestart"
                    value="${CONFIG.preStartMin}" min="0" max="30">

                <label>单次开售时间（关闭每天模式时使用）</label>
                <input type="datetime-local" id="cfg-sale-time"
                    value="${CONFIG.saleTime ? CONFIG.saleTime.replace(' ', 'T') : ''}">

                <label>目标套餐</label>
                <select id="cfg-plan">
                    <option value="Lite" ${CONFIG.targetPlan === 'Lite' ? 'selected' : ''}>Lite - ¥49/月 (3x Claude Pro)</option>
                    <option value="Pro" ${CONFIG.targetPlan === 'Pro' ? 'selected' : ''}>Pro - ¥149/月 (最受欢迎)</option>
                    <option value="Max" ${CONFIG.targetPlan === 'Max' ? 'selected' : ''}>Max - ¥469/月 (最大管饱)</option>
                </select>

                <label>计费周期</label>
                <select id="cfg-cycle">
                    <option value="monthly" ${CONFIG.billingCycle === 'monthly' ? 'selected' : ''}>连续包月</option>
                    <option value="quarterly" ${CONFIG.billingCycle === 'quarterly' ? 'selected' : ''}>连续包季 (9折)</option>
                    <option value="yearly" ${CONFIG.billingCycle === 'yearly' ? 'selected' : ''}>连续包年 (8折)</option>
                </select>

                <label>
                    <input type="checkbox" id="cfg-autoclick" ${CONFIG.autoClick ? 'checked' : ''}>
                    检测到可购买时自动点击
                </label>

                <label>
                    <input type="checkbox" id="cfg-retry" ${CONFIG.retryOnBusy ? 'checked' : ''}>
                    "抢购人数过多"时自动刷新重试
                </label>

                <label>监控间隔 (毫秒)</label>
                <input type="number" id="cfg-interval"
                    value="${CONFIG.checkInterval}" min="50" max="5000">

                <label>
                    <input type="checkbox" id="cfg-autorefresh" ${CONFIG.autoRefreshOnSale ? 'checked' : ''}>
                    到点自动刷新页面
                </label>

                <label>提前刷新秒数</label>
                <input type="number" id="cfg-prerefresh"
                    value="${CONFIG.preRefreshSec}" min="1" max="30">

                <div class="sniper-config-actions">
                    <button class="save" id="cfg-save">保存</button>
                    <button class="cancel" id="cfg-cancel">取消</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
        document.getElementById('cfg-cancel').onclick = () => overlay.remove();

        document.getElementById('cfg-save').onclick = () => {
            const saleTimeInput = document.getElementById('cfg-sale-time').value;
            CONFIG.dailyMode = document.getElementById('cfg-daily-mode').checked;
            CONFIG.dailySaleTime = normalizeDailySaleTime(document.getElementById('cfg-daily-time').value);
            CONFIG.preStartMin = parseInt(document.getElementById('cfg-prestart').value, 10) || 0;
            CONFIG.saleTime = normalizeSaleTime(saleTimeInput);
            CONFIG.targetPlan = normalizePlanName(document.getElementById('cfg-plan').value);
            CONFIG.billingCycle = document.getElementById('cfg-cycle').value;
            CONFIG.autoClick = document.getElementById('cfg-autoclick').checked;
            CONFIG.retryOnBusy = document.getElementById('cfg-retry').checked;
            CONFIG.checkInterval = parseInt(document.getElementById('cfg-interval').value) || 300;
            CONFIG.autoRefreshOnSale = document.getElementById('cfg-autorefresh').checked;
            CONFIG.preRefreshSec = parseInt(document.getElementById('cfg-prerefresh').value) || 3;

            try { GM_setValue('sniper_config_v3', JSON.stringify(CONFIG)); } catch (e) { /* ignore */ }

            if (state.saleTimer) clearInterval(state.saleTimer);
            initSaleTimer();

            log(`已保存: ${getTargetPlanName()} / ${CYCLE_LABELS[CONFIG.billingCycle]}`, 'success');
            overlay.remove();
        };
    }

    // ==================== 配置持久化 ====================
    function loadSavedConfig() {
        try {
            const saved = GM_getValue('sniper_config_v3');
            if (saved) {
                const parsed = JSON.parse(saved);
                Object.assign(CONFIG, parsed);
                CONFIG.targetPlan = normalizePlanName(CONFIG.targetPlan);
                CONFIG.saleTime = normalizeSaleTime(CONFIG.saleTime);
                CONFIG.dailyMode = CONFIG.dailyMode !== false;
                CONFIG.dailySaleTime = normalizeDailySaleTime(CONFIG.dailySaleTime);
                CONFIG.preStartMin = Number.isFinite(Number(CONFIG.preStartMin)) ? Number(CONFIG.preStartMin) : 3;
            }
        } catch (e) { /* ignore */ }
    }

    // ==================== 拖拽 ====================
    function makeDraggable(panel, handle) {
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        handle.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            panel.style.left = (startLeft + e.clientX - startX) + 'px';
            panel.style.top = (startTop + e.clientY - startY) + 'px';
            panel.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => { isDragging = false; });
    }

    // ==================== 初始化 ====================
    function init() {
        loadSavedConfig();
        createPanel();

        if (CONFIG.dailyMode || CONFIG.saleTime) {
            initSaleTimer();
        }

        if (Notification.permission === 'default') {
            Notification.requestPermission();
        }

        log(`GLM 抢购助手 v3.2 已加载`, 'success');
        log(`目标: ${getTargetPlanName()} / ${CYCLE_LABELS[CONFIG.billingCycle]}`, 'info');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
