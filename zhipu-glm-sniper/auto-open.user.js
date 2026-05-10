// ==UserScript==
// @name         GLM 抢购定时打开
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  到点自动打开智谱GLM Coding抢购页面
// @author       codex-rag
// @match        *://*/*
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const TARGET_URL = 'https://bigmodel.cn/glm-coding';
    const CONFIG_KEY = 'sniper_config_v3';
    const OPENED_KEY = 'sniper_auto_opened_date';

    function getConfig() {
        try {
            const saved = GM_getValue(CONFIG_KEY);
            const config = saved ? JSON.parse(saved) : {};
            return {
                dailyMode: config.dailyMode !== false,
                dailySaleTime: normalizeDailySaleTime(config.dailySaleTime),
                saleTime: config.saleTime || '',
                preStartMin: Number.isFinite(Number(config.preStartMin)) ? Number(config.preStartMin) : 3,
            };
        } catch (e) {
            return {
                dailyMode: true,
                dailySaleTime: '10:00:00',
                saleTime: '',
                preStartMin: 3,
            };
        }
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

    function getSaleInfo(config, now = new Date()) {
        if (!config.dailyMode) {
            const ts = new Date(config.saleTime).getTime();
            return {
                ts,
                key: config.saleTime || 'manual',
                label: config.saleTime || '',
            };
        }

        const [h, m, s] = config.dailySaleTime.split(':').map(Number);
        const saleDate = new Date(now);
        saleDate.setHours(h, m, s || 0, 0);

        const lateWindowMs = 5 * 60 * 1000;
        if (now.getTime() - saleDate.getTime() > lateWindowMs) {
            saleDate.setDate(saleDate.getDate() + 1);
        }

        const dateKey = `${saleDate.getFullYear()}-${String(saleDate.getMonth() + 1).padStart(2, '0')}-${String(saleDate.getDate()).padStart(2, '0')}`;
        return {
            ts: saleDate.getTime(),
            key: `${dateKey} ${config.dailySaleTime}`,
            label: `每天 ${config.dailySaleTime}`,
        };
    }

    function checkAndOpen() {
        const config = getConfig();
        if (!config.dailyMode && !config.saleTime) return;

        const sale = getSaleInfo(config);
        if (isNaN(sale.ts)) return;

        const now = Date.now();
        const diff = sale.ts - now;

        // 默认提前 3 分钟到开售后 5 分钟内都打开
        const EARLY_MS = Math.max(0, config.preStartMin || 3) * 60 * 1000;
        const LATE_MS = 5 * 60 * 1000;

        if (diff > -LATE_MS && diff <= EARLY_MS) {
            const lastOpened = GM_getValue(OPENED_KEY, '');
            if (lastOpened === sale.key) return;

            GM_setValue(OPENED_KEY, sale.key);

            // 打开抢购页面
            GM_openInTab(TARGET_URL, { active: true });

            GM_notification({
                title: 'GLM 抢购助手',
                text: `已自动打开抢购页面\n开售时间: ${sale.label}\n提前运行: ${config.preStartMin || 3} 分钟`,
                timeout: 10000,
            });
        }
    }

    // 每 5 秒检查一次
    setInterval(checkAndOpen, 5000);
    checkAndOpen();
})();
