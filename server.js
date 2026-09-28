const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

let sessionData = [];
let totalWins = 0;
let totalJackpots = 0;
let currentLevel = 1;
let consecutiveLosses = 0;
let currentActive = null;
let lastProcessedIssue = "";
let isTickRunning = false;

function getSize(num) { return num >= 5 ? "BIG" : "SMALL"; }
function getColor(num) {
    if ([0,2,4,6,8].includes(num)) return "RED";
    if ([1,3,5,7,9].includes(num)) return "GREEN";
    return "UNKNOWN";
}
function getPredColor(t) {
    if (t === "BIG") return "#ffd700";
    if (t === "SMALL") return "#00d9ff";
    return "#8888aa";
}

function getSmartPrediction(rawNums, currentIssueStr) {
    if (!rawNums || rawNums.length < 8) {
        return { trend: "BIG", isSkip: false, main: 7, opp: 2, confidence: 80 };
    }
    const sizes = rawNums.map(n => getSize(n));
    const lastDigit = rawNums[0];

    const last5 = sizes.slice(0, 5);
    const isClusterBig = last5.filter(s => s === "BIG").length >= 4;
    const isClusterSmall = last5.filter(s => s === "BIG").length <= 1;

    const win15 = sizes.slice(0, 15);
    const big15 = win15.filter(s => s === "BIG").length;
    const isDominantBig15 = big15 >= 10;
    const isDominantSmall15 = big15 <= 5;

    let streaks = [];
    let cur = sizes[0], count = 0;
    for (let s of sizes) {
        if (s === cur) count++;
        else { streaks.push({ side: cur, count }); cur = s; count = 1; }
        if (streaks.length >= 7) break;
    }
    if (count > 0 && streaks.length < 7) streaks.push({ side: cur, count });

    const s0 = streaks[0]?.count || 1;
    const s1 = streaks[1]?.count || 0;
    const s2 = streaks[2]?.count || 0;
    const s3 = streaks[3]?.count || 0;

    let patternTrend = null, patternConfidence = 0, patternLabel = "";

    const is2121Wave = (s1 === 2 && s2 === 1 && s3 === 2) || (s1 === 1 && s2 === 2 && s3 === 1 && streaks[4]?.count === 2);
    const isVerified22 = (s1 === 2 && s2 === 2) || (s1 === 2 && s3 === 2);

    if (s0 >= 4) {
        patternTrend = sizes[0];
        patternConfidence = Math.min(96, 88 + s0 * 2);
        patternLabel = `🔥 DRAGON RUN (${s0}x ${sizes[0]})`;
    } else if (s0 === 3) {
        patternTrend = sizes[0];
        patternConfidence = 87;
        patternLabel = `📈 3-RUN STREAK (${sizes[0]})`;
    } else if (is2121Wave) {
        if (s0 === 1 && s1 === 2) { patternTrend = streaks[1].side; patternConfidence = 90; patternLabel = `⚡ 2-1-2 WAVE SNAP`; }
        else if (s0 === 1 && s1 === 1) { patternTrend = sizes[0]; patternConfidence = 88; patternLabel = `✨ 2-1-2 TWIN COMPLETION`; }
        else if (s0 === 2 && s1 === 1) { patternTrend = streaks[1].side; patternConfidence = 87; patternLabel = `🎯 2-1-2 TWIN BREAK`; }
    } else if (s0 === 2 && (isVerified22 || s1 === 2)) {
        patternTrend = sizes[0] === "BIG" ? "SMALL" : "BIG";
        patternConfidence = 88;
        patternLabel = `✨ 2-2 FLIP`;
    } else if (s0 === 1 && (isVerified22 || (s1 === 2 && s1 < 4))) {
        patternTrend = sizes[0];
        patternConfidence = 88;
        patternLabel = `✨ 2-2 PAIR COMPLETION`;
    } else if (sizes.length >= 3 && sizes[0] !== sizes[1] && sizes[1] !== sizes[2] && sizes[0] === sizes[2]) {
        patternTrend = sizes[0] === "BIG" ? "SMALL" : "BIG";
        patternConfidence = 87;
        patternLabel = `🎯 TRIPLE MIXED`;
    } else if (s0 === 1 && s1 >= 4) {
        patternTrend = streaks[1].side;
        patternConfidence = 85;
        patternLabel = `🎯 DRAGON SNAPBACK`;
    } else if (s0 === 1 && (isClusterBig || isClusterSmall)) {
        patternTrend = isClusterBig ? "BIG" : "SMALL";
        patternConfidence = 84;
        patternLabel = `🛡️ CLUSTER NOISE FILTER`;
    } else if (isDominantBig15) {
        patternTrend = "BIG"; patternConfidence = 82; patternLabel = `👑 MACRO BIG`;
    } else if (isDominantSmall15) {
        patternTrend = "SMALL"; patternConfidence = 82; patternLabel = `👑 MACRO SMALL`;
    } else {
        const last10 = rawNums.slice(0, 10);
        const bigCount10 = last10.filter(n => n >= 5).length;
        patternTrend = bigCount10 >= 5 ? "BIG" : "SMALL";
        patternConfidence = 78;
        patternLabel = `📊 FREQUENCY FALLBACK`;
    }

    const cleanIssue = String(currentIssueStr || "").replace(/\D/g, "");
    const seed = parseInt(cleanIssue.slice(-3)) || 100;
    let n1 = patternTrend === "BIG" ? [5,6,7,8,9][Math.abs(seed + lastDigit) % 5] : [0,1,2,3,4][Math.abs(seed + lastDigit) % 5];
    let n2 = patternTrend === "BIG" ? [0,1,2,3,4][Math.abs(seed * 3) % 5] : [5,6,7,8,9][Math.abs(seed * 7) % 5];

    return { trend: patternTrend, isSkip: false, main: n1, opp: n2, confidence: patternConfidence, label: patternLabel };
}

async function fetchGameData() {
    const targetUrl = `https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?t=${Date.now()}`;
    try {
        const res = await fetch(targetUrl, { timeout: 3000 });
        if (res.ok) {
            const data = await res.json();
            return data?.data?.list || data?.list || null;
        }
    } catch(e) {}
    return null;
}

function updateLevel(isWin) {
    if (isWin) {
        consecutiveLosses = 0;
        currentLevel = 1;
    } else {
        consecutiveLosses++;
        currentLevel = currentLevel >= 3 ? 1 : currentLevel + 1;
    }
}

async function tick() {
    if (isTickRunning) return;
    isTickRunning = true;

    try {
        const list = await fetchGameData();
        if (!list || !list.length) return;

        const latest = list[0];
        const issue = String(latest.issueNumber ?? latest.issue ?? latest.period ?? "");
        const actualNum = parseInt(latest.number ?? latest.openNum ?? latest.num ?? 0);
        const cleanIssue = issue.replace(/\D/g, "");
        const periodShort = cleanIssue.slice(-4);
        const actualSize = getSize(actualNum);
        const actualColor = getColor(actualNum);

        if (currentActive && lastProcessedIssue !== cleanIssue) {
            if (!sessionData.some(x => x.period === periodShort) && currentActive.periodShort === periodShort) {
                const matched = (currentActive.trend === actualSize);
                const isJackpot = (actualNum === currentActive.main || actualNum === currentActive.opp);
                let status = "", rowClass = "";

                if (matched) {
                    if (isJackpot) {
                        status = '<span class="tag-jackpot">🎰 JACKPOT</span>';
                        totalJackpots++;
                        rowClass = 'row-jackpot';
                    } else {
                        status = '<span class="tag-win">✅ WIN</span>';
                        totalWins++;
                        rowClass = 'row-win';
                    }
                    updateLevel(true);
                } else {
                    status = '<span class="tag-loss">❌ LOSS</span>';
                    rowClass = 'row-loss';
                    updateLevel(false);
                }

                sessionData.unshift({
                    period: periodShort,
                    pred: currentActive.trend,
                    isSkip: false,
                    predColor: getPredColor(currentActive.trend),
                    mainNum: currentActive.main,
                    oppNum: currentActive.opp,
                    actual: `${actualSize}/${actualColor}`,
                    actualColor: getPredColor(actualSize),
                    actualNum,
                    status,
                    class: rowClass
                });

                if (sessionData.length > 500) sessionData.pop();
            }
        }
        lastProcessedIssue = cleanIssue;

        const nextTail = (parseInt(cleanIssue.slice(-4)) + 1).toString().padStart(4, '0');
        const nextFull = cleanIssue.slice(0, -4) + nextTail;
        const nextShort = nextFull.slice(-4);

        const rawNums = list.map(x => parseInt(x.number ?? x.openNum ?? x.num ?? 0)).filter(n => !isNaN(n));
        const pred = getSmartPrediction(rawNums, cleanIssue);

        currentActive = {
            periodFull: nextFull,
            periodShort: nextShort,
            trend: pred.trend,
            main: pred.main,
            opp: pred.opp,
            confidence: pred.confidence,
            label: pred.label
        };
    } catch(err) {
        console.error('Tick Error:', err);
    } finally {
        isTickRunning = false;
    }
}

// 24/7 background interval
setInterval(tick, 3000);

// API Endpoint for your web UI
app.get('/api/state', (req, res) => {
    res.json({
        currentActive,
        sessionData: sessionData.slice(0, 100),
        stats: { totalWins, totalJackpots },
        level: { currentLevel, consecutiveLosses }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server online on port ${PORT}`));
