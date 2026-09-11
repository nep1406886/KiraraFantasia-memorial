(function () {
    "use strict";

    var data = window.kirafanGachaData;
    var assetRoot = "https://asset.kirafan.cn/texture/charauiresource/";
    var itemIconRoot = "https://asset.kirafan.cn/texture/itemicon/itemicon_";
    var recordKey = "kirafan-memorial-gacha-record-v1";
    var soundKey = "kirafan-memorial-gacha-sound-v1";
    var includeOriginalKey = "kirafan-memorial-gacha-original-v1";
    var languageKey = "kirafan-memorial-gacha-language-v1";
    var originalTitleType = data && data.meta && Number.isFinite(data.meta.originalTitleType)
        ? data.meta.originalTitleType
        : 22;
    var pageSize = 24;
    var classIconFiles = {
        0: "gacha/ui/ClassIconFighter.png",
        1: "gacha/ui/ClassIconMagician.png",
        2: "gacha/ui/ClassIconPriest.png",
        3: "gacha/ui/ClassIconKnight.png",
        4: "gacha/ui/ClassIconAlchemist.png"
    };
    var titleVoiceCueByTitleId = {
        0: "006", 1: "007", 2: "003", 3: "000", 4: "004", 5: "001", 6: "005", 7: "002",
        8: "008", 9: "009", 10: "010", 11: "011", 12: "015", 13: "012", 14: "014", 15: "013",
        16: "016", 17: "017", 18: "018", 19: "019", 20: "028", 21: "029", 23: "031", 24: "030",
        25: "033", 26: "034", 27: "036", 28: "035", 29: "037", 30: "039", 31: "038", 32: "040",
        33: "041", 34: "051", 35: "053", 36: "052", 37: "054"
    };
    var elementIconFiles = {
        0: "gacha/ui/ElementIconFire.png",
        1: "gacha/ui/ElementIconWater.png",
        2: "gacha/ui/ElementIconEarth.png",
        3: "gacha/ui/ElementIconWind.png",
        4: "gacha/ui/ElementIconMoon.png",
        5: "gacha/ui/ElementIconSun.png"
    };
    var summonAudioFiles = {
        roomMorningVoice: "audio/gacha/claire-room-morning.mp3",
        roomDayVoice: "audio/gacha/claire-room-day.mp3",
        roomNightVoice: "audio/gacha/claire-room-night.mp3",
        gachaBgm: "audio/gacha/bgm-gacha.mp3",
        summonBgm: "audio/gacha/bgm-summon.mp3",
        titleVoicePrefix: "audio/gacha/title-voice/voice-title-"
    };

    var state = {
        catalogPage: 1,
        record: readRecord(),
        activeCards: [],
        pools: { 3: [], 4: [], 5: [] },
        soundEnabled: readSoundPreference(),
        includeOriginal: readIncludeOriginalPreference(),
        language: readLanguagePreference(),
        finishSummonAnimation: null,
        roomVoice: null,
        claireCue: null,
        titleVoice: null,
        resultVoice: null,
        resultVoiceTimer: null,
        summonBgm: null,
        roomGreetingPlayed: false,
        keyRendererPromise: null,
        summonInProgress: false,
        lastDrawCount: 0,
        viewer: {
            card: null,
            evolved: false,
            mode: "card",
            cards: [],
            index: 0
        }
    };

    function byId(id) {
        return document.getElementById(id);
    }

    function clearElement(element) {
        while (element.firstChild) {
            element.removeChild(element.firstChild);
        }
    }

    function loadGachaKeyRenderer() {
        if (!state.keyRendererPromise) {
            state.keyRendererPromise = import("./gacha-key-3d.js?v=20260818-1").then(function (module) {
                return module.initGachaKeyRenderer();
            }).catch(function () {
                return null;
            });
        }
        return state.keyRendererPromise;
    }

    function updateGachaKeyPhase(phaseNames) {
        if (!state.keyRendererPromise) {
            return;
        }
        var keyPhase = ["phase-key-lock", "phase-key-focus", "phase-key-flight"].find(function (name) {
            return phaseNames.indexOf(name) !== -1;
        }) || "";
        state.keyRendererPromise.then(function (renderer) {
            if (renderer) {
                renderer.setPhase(keyPhase);
            }
        });
    }

    function readRecord() {
        try {
            var saved = JSON.parse(window.localStorage.getItem(recordKey));
            if (saved && Number.isFinite(saved.total) && Number.isFinite(saved.fiveStars) && Array.isArray(saved.owned)) {
                return {
                    total: Math.max(0, saved.total),
                    fiveStars: Math.max(0, saved.fiveStars),
                    owned: saved.owned.filter(function (id) { return Number.isFinite(id); }),
                    history: Array.isArray(saved.history) ? saved.history.filter(function (entry) {
                        return entry && typeof entry.at === "string" && Array.isArray(entry.cards);
                    }).map(function (entry) {
                        return {
                            at: entry.at,
                            cards: entry.cards.filter(function (card) {
                                return card && Number.isFinite(card.id);
                            }).map(function (card) {
                                return { id: card.id, isNew: Boolean(card.isNew) };
                            })
                        };
                    }).slice(0, 30) : []
                };
            }
        } catch (error) {
            // localStorage can be disabled; the summon page still works without persistence.
        }
        return { total: 0, fiveStars: 0, owned: [], history: [] };
    }

    function writeRecord() {
        try {
            window.localStorage.setItem(recordKey, JSON.stringify(state.record));
        } catch (error) {
            return;
        }
    }

    function readSoundPreference() {
        try {
            return window.localStorage.getItem(soundKey) !== "off";
        } catch (error) {
            return true;
        }
    }

    function writeSoundPreference() {
        try {
            window.localStorage.setItem(soundKey, state.soundEnabled ? "on" : "off");
        } catch (error) {
            return;
        }
    }

    function readIncludeOriginalPreference() {
        try {
            return window.localStorage.getItem(includeOriginalKey) === "on";
        } catch (error) {
            return false;
        }
    }

    function writeIncludeOriginalPreference() {
        try {
            window.localStorage.setItem(includeOriginalKey, state.includeOriginal ? "on" : "off");
        } catch (error) {
            return;
        }
    }

    function readLanguagePreference() {
        try {
            var language = window.localStorage.getItem(languageKey);
            return ["zh", "ja", "en"].indexOf(language) !== -1 ? language : "zh";
        } catch (error) {
            return "zh";
        }
    }

    function writeLanguagePreference() {
        try {
            window.localStorage.setItem(languageKey, state.language);
        } catch (error) {
            return;
        }
    }

    function updateSoundButton() {
        var button = byId("soundToggle");
        button.classList.toggle("is-muted", !state.soundEnabled);
        button.setAttribute("aria-pressed", String(state.soundEnabled));
        button.setAttribute("aria-label", state.soundEnabled ? "关闭召唤演出音" : "开启召唤演出音");
        button.title = state.soundEnabled ? "关闭召唤演出音" : "开启召唤演出音";
        button.textContent = "♪";
    }

    function randomUnit() {
        if (window.crypto && window.crypto.getRandomValues) {
            var values = new Uint32Array(1);
            window.crypto.getRandomValues(values);
            return values[0] / 4294967296;
        }
        return Math.random();
    }

    function pickRandom(items) {
        return items[Math.floor(randomUnit() * items.length)];
    }

    function localDebugSummonOptions() {
        if (window.location.hostname !== "127.0.0.1" && window.location.hostname !== "localhost") {
            return null;
        }
        var parameters = new URLSearchParams(window.location.search);
        var rarity = Number(parameters.get("debugRarity"));
        var classType = Number(parameters.get("debugClass"));
        var fiveStarCount = Number(parameters.get("debugFive"));
        return {
            rarity: [3, 4, 5].indexOf(rarity) !== -1 ? rarity : null,
            classType: [0, 1, 2, 3, 4].indexOf(classType) !== -1 ? classType : null,
            fiveStarCount: Number.isFinite(fiveStarCount) ? Math.max(0, Math.floor(fiveStarCount)) : 0
        };
    }

    function chooseRarity(guaranteedFourStar) {
        var roll = randomUnit();
        if (guaranteedFourStar) {
            return roll < 0.02 ? 5 : 4;
        }
        if (roll < 0.02) {
            return 5;
        }
        if (roll < 0.14) {
            return 4;
        }
        return 3;
    }

    function displayedCardId(card, evolved) {
        return evolved && card.evolvedId ? card.evolvedId : card.id;
    }

    function cardArtUrl(card, evolved, highResolution) {
        return assetRoot + "characard/characard_" + displayedCardId(card, evolved) + (highResolution ? ".png" : ".jpg");
    }

    function cardIconUrl(card, evolved) {
        return assetRoot + "charaicon/charaicon_" + displayedCardId(card, evolved) + ".png";
    }

    function cardStandUrl(card, evolved) {
        return assetRoot + "charaillustchara/charaillust_chara_" + displayedCardId(card, evolved) + ".png";
    }

    function localIconUrl(files, value) {
        var file = files[String(value)];
        return file ? "imgs/" + file : "";
    }

    function cardElementIconUrl(card) {
        return localIconUrl(elementIconFiles, card.element);
    }

    function cardClassIconUrl(card) {
        return localIconUrl(classIconFiles, card.class);
    }

    function duplicateRewardUrl(card) {
        if (card.rarity === 5 && Number.isFinite(card.titleId)) {
            return itemIconRoot + String(5000 + Number(card.titleId)) + ".png";
        }
        var classRewardIds = {
            0: 4010,
            1: 4012,
            2: 4014,
            3: 4011,
            4: 4013
        };
        return itemIconRoot + String(classRewardIds[card.class] || 4102) + ".png";
    }

    function hasFullIllustration(card, evolved) {
        return Boolean(evolved ? card.evolvedHasFullIllustration : card.hasFullIllustration);
    }

    function cardFullIllustrationUrl(card, evolved) {
        return assetRoot + "charaillustfull/charaillust_full_" + displayedCardId(card, evolved) + ".png";
    }

    function starText(rarity) {
        return new Array(rarity + 1).join("★");
    }

    function displayName(card) {
        if (state.language === "ja") {
            return card.name || card.nameZh || card.nameEn;
        }
        if (state.language === "en") {
            return card.nameEn || card.name || card.nameZh;
        }
        return card.nameZh || card.name || card.nameEn;
    }

    function displayTitle(card) {
        if (state.language === "ja") {
            return card.title || card.titleZh || card.titleEn;
        }
        if (state.language === "en") {
            return card.titleEn || card.title || card.titleZh;
        }
        return card.titleZh || card.title || card.titleEn;
    }

    function cardImageSources(card, options) {
        if (options.kind === "stand") {
            return [cardStandUrl(card, options.evolved)];
        }
        if (options.kind === "full") {
            return hasFullIllustration(card, options.evolved)
                ? [cardFullIllustrationUrl(card, options.evolved)]
                : [];
        }
        if (options.highResolution) {
            return [
                cardArtUrl(card, options.evolved, true),
                cardArtUrl(card, options.evolved, false)
            ];
        }
        return [cardArtUrl(card, options.evolved, false)];
    }

    function cardImageLabel(card, options) {
        if (options.kind === "stand") {
            return displayName(card) + (options.evolved ? "进化后透明立绘" : "初始透明立绘");
        }
        if (options.kind === "full") {
            return displayName(card) + (options.evolved ? "进化后背景插图" : "初始背景插图");
        }
        return displayName(card) + (options.evolved ? "进化后卡面" : "初始卡面");
    }

    function setCardImage(image, container, card, options) {
        image.kirafanSources = cardImageSources(card, options);
        image.kirafanSourceIndex = 0;
        image.alt = cardImageLabel(card, options);
        image.loading = options.eager ? "eager" : "lazy";
        image.fetchPriority = options.eager ? "high" : "auto";
        container.classList.remove("is-image-unavailable", "is-stand", "is-full");
        container.classList.toggle("is-stand", options.kind === "stand");
        container.classList.toggle("is-full", options.kind === "full");
        if (image.kirafanSources.length === 0) {
            container.classList.add("is-image-unavailable");
            image.hidden = true;
            image.removeAttribute("src");
            return;
        }
        image.hidden = false;
        image.src = image.kirafanSources[0];
    }

    function appendCardImage(container, card, options) {
        var image = document.createElement("img");
        image.decoding = "async";
        image.addEventListener("error", function handleError() {
            image.kirafanSourceIndex += 1;
            if (image.kirafanSourceIndex < image.kirafanSources.length) {
                image.src = image.kirafanSources[image.kirafanSourceIndex];
                return;
            }
            if (!container.classList.contains("is-image-unavailable")) {
                container.classList.add("is-image-unavailable");
            }
            image.hidden = true;
        });
        container.appendChild(image);
        setCardImage(image, container, card, options);
        return image;
    }

    function setAvatarImage(image, frame, card, evolved) {
        frame.classList.remove("is-image-unavailable");
        frame.dataset.rarity = String(card.rarity);
        image.hidden = false;
        image.alt = displayName(card) + (evolved ? "进化后小头像" : "小头像");
        image.src = cardIconUrl(card, evolved);
    }

    function appendAvatarImage(frame, card, evolved, eager) {
        var image = document.createElement("img");
        image.decoding = "async";
        image.loading = eager ? "eager" : "lazy";
        image.fetchPriority = eager ? "high" : "auto";
        image.addEventListener("error", function () {
            frame.classList.add("is-image-unavailable");
            image.hidden = true;
        });
        frame.appendChild(image);
        setAvatarImage(image, frame, card, evolved);
        return image;
    }

    function appendAvatarBadge(container, className, source, alt) {
        if (!source) {
            return;
        }
        var image = document.createElement("img");
        image.className = className;
        image.src = source;
        image.alt = alt;
        image.loading = "eager";
        image.decoding = "async";
        image.addEventListener("error", function () {
            image.remove();
        });
        container.appendChild(image);
    }

    function setAvatarDecorations(container, card) {
        Array.from(container.querySelectorAll(".avatar-element, .avatar-class")).forEach(function (badge) {
            badge.remove();
        });
        appendAvatarBadge(container, "avatar-element", cardElementIconUrl(card), "");
        appendAvatarBadge(container, "avatar-class", cardClassIconUrl(card), "");
    }

    function updateViewer() {
        var card = state.viewer.card;
        if (!card) {
            return;
        }

        var evolved = state.viewer.evolved && Boolean(card.evolvedId);
        state.viewer.evolved = evolved;
        byId("viewerTitle").textContent = displayName(card);
        byId("viewerSubtitle").textContent = displayTitle(card);
        byId("viewerRarity").textContent = starText(card.rarity);
        byId("viewerForm").textContent = evolved ? "进化后" : "初始";
        byId("viewerPosition").textContent = (state.viewer.index + 1) + " / " + state.viewer.cards.length;
        setAvatarImage(byId("viewerAvatar"), byId("viewerAvatarFrame"), card, evolved);
        setAvatarDecorations(byId("viewerAvatarFrame"), card);

        var media = byId("viewerMedia");
        clearElement(media);
        appendCardImage(media, card, {
            evolved: evolved,
            highResolution: true,
            eager: true,
            kind: state.viewer.mode
        });

        var evolutionControls = byId("viewerEvolution");
        evolutionControls.hidden = !card.evolvedId;
        [byId("viewerBase"), byId("viewerEvolved")].forEach(function (button) {
            var active = button === byId(evolved ? "viewerEvolved" : "viewerBase");
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", String(active));
        });
        var fullButton = byId("viewerFullIllustration");
        fullButton.hidden = !hasFullIllustration(card, evolved);
        if (state.viewer.mode === "full" && fullButton.hidden) {
            state.viewer.mode = "card";
            updateViewer();
            return;
        }
        [byId("viewerCardArt"), byId("viewerStand"), fullButton].forEach(function (button) {
            var buttonMode = button === byId("viewerCardArt") ? "card" : button === byId("viewerStand") ? "stand" : "full";
            var active = buttonMode === state.viewer.mode;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", String(active));
        });
        byId("viewerPrevious").disabled = state.viewer.index === 0;
        byId("viewerNext").disabled = state.viewer.index === state.viewer.cards.length - 1;
    }

    function openCardViewer(card, evolved, cards) {
        var dialog = byId("cardViewer");
        var contextCards = Array.isArray(cards) && cards.length ? cards : [card];
        var contextIndex = contextCards.indexOf(card);
        state.viewer.card = card;
        state.viewer.evolved = Boolean(evolved && card.evolvedId);
        state.viewer.mode = "card";
        state.viewer.cards = contextCards;
        state.viewer.index = contextIndex < 0 ? 0 : contextIndex;
        updateViewer();
        if (!dialog.open) {
            dialog.showModal();
        }
        document.body.classList.add("viewer-open");
    }

    function moveViewer(offset) {
        var nextIndex = state.viewer.index + offset;
        if (nextIndex < 0 || nextIndex >= state.viewer.cards.length) {
            return;
        }
        state.viewer.index = nextIndex;
        state.viewer.card = state.viewer.cards[nextIndex];
        state.viewer.evolved = false;
        if (state.viewer.mode === "full" && !hasFullIllustration(state.viewer.card, false)) {
            state.viewer.mode = "card";
        }
        updateViewer();
    }

    function closeCardViewer() {
        var dialog = byId("cardViewer");
        if (dialog.open) {
            dialog.close();
        }
    }

    function createDrawCard(result, index, cards) {
        var card = result.card;
        var article = document.createElement("article");
        article.className = "draw-card";
        article.dataset.rarity = String(card.rarity);
        article.dataset.new = String(result.isNew);
        article.style.animationDelay = (index * 55) + "ms";

        var button = document.createElement("button");
        button.type = "button";
        button.className = "draw-card-open";
        button.setAttribute(
            "aria-label",
            starText(card.rarity) + " " + displayName(card) + (result.isNew ? "，首次相遇" : "，重复召唤") + "；查看高清卡面与立绘"
        );
        button.addEventListener("click", function () {
            openCardViewer(card, false, cards);
        });

        var media = document.createElement("span");
        media.className = "draw-card-media";
        appendAvatarImage(media, card, false, true);
        setAvatarDecorations(media, card);
        if (result.isNew) {
            appendAvatarBadge(media, "draw-card-new", "imgs/gacha/ui/NEWIcon.png", "首次相遇");
        } else {
            appendAvatarBadge(media, "draw-card-duplicate", duplicateRewardUrl(card), "重复召唤结晶");
        }

        button.appendChild(media);
        article.appendChild(button);
        return article;
    }

    function createCatalogCard(card, contextCards) {
        var article = document.createElement("article");
        article.className = "catalog-card";
        article.dataset.rarity = String(card.rarity);

        var button = document.createElement("button");
        button.type = "button";
        button.className = "catalog-card-open";
        button.setAttribute("aria-label", "查看 " + displayName(card) + " 的高清卡面");
        button.addEventListener("click", function () {
            openCardViewer(card, false, contextCards);
        });

        var imageBox = document.createElement("div");
        imageBox.className = "catalog-card-image";
        appendCardImage(imageBox, card, {
            evolved: false,
            highResolution: true,
            eager: false,
            kind: "card"
        });

        var identity = document.createElement("div");
        identity.className = "catalog-card-identity";
        var avatar = document.createElement("span");
        avatar.className = "catalog-card-avatar";
        appendAvatarImage(avatar, card, false, false);
        setAvatarDecorations(avatar, card);
        var identityCopy = document.createElement("span");
        identityCopy.className = "catalog-card-copy";
        var name = document.createElement("strong");
        name.textContent = displayName(card);
        name.title = displayName(card);
        var title = document.createElement("small");
        title.textContent = displayTitle(card);
        title.title = displayTitle(card);
        identityCopy.appendChild(name);
        identityCopy.appendChild(title);
        identity.appendChild(avatar);
        identity.appendChild(identityCopy);

        var meta = document.createElement("div");
        meta.className = "catalog-card-meta";
        var rarity = document.createElement("span");
        rarity.textContent = starText(card.rarity);
        var year = document.createElement("span");
        year.textContent = card.year || "";
        meta.appendChild(rarity);
        meta.appendChild(year);

        button.appendChild(imageBox);
        button.appendChild(identity);
        button.appendChild(meta);
        article.appendChild(button);
        return article;
    }

    function updateRecordDisplay() {
        byId("totalDraws").textContent = state.record.total;
        byId("fiveStarDraws").textContent = state.record.fiveStars;
        byId("ownedCards").textContent = state.record.owned.length;
    }

    function renderSummonHistory() {
        var list = byId("summonHistoryList");
        clearElement(list);
        var history = state.record.history || [];
        var drawCount = history.reduce(function (total, entry) { return total + entry.cards.length; }, 0);
        byId("summonHistorySummary").textContent = history.length > 0
            ? "保留最近 " + history.length + " 次召唤，共 " + drawCount + " 张卡。"
            : "还没有本地抽卡历史。";
        byId("clearSummonHistory").disabled = history.length === 0;
        byId("resetSummonRecord").disabled = state.record.total === 0
            && state.record.fiveStars === 0
            && state.record.owned.length === 0
            && history.length === 0;

        if (history.length === 0) {
            var empty = document.createElement("p");
            empty.className = "summon-history-empty";
            empty.textContent = "完成一次召唤后，记录会显示在这里。";
            list.appendChild(empty);
            return;
        }

        var cardMap = new Map(data.cards.map(function (card) { return [card.id, card]; }));
        history.forEach(function (entry) {
            var cards = entry.cards.map(function (item) { return cardMap.get(item.id); }).filter(Boolean);
            var article = document.createElement("article");
            article.className = "summon-history-entry";
            var header = document.createElement("header");
            var time = document.createElement("time");
            time.dateTime = entry.at;
            time.textContent = new Date(entry.at).toLocaleString("zh-CN", {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
            });
            var summary = document.createElement("span");
            var fiveStars = cards.filter(function (card) { return card.rarity === 5; }).length;
            summary.textContent = cards.length + " 张" + (fiveStars > 0 ? " · ★5 " + fiveStars : "");
            header.appendChild(time);
            header.appendChild(summary);
            article.appendChild(header);

            var cardList = document.createElement("div");
            cardList.className = "summon-history-cards";
            entry.cards.forEach(function (item) {
                var card = cardMap.get(item.id);
                if (!card) {
                    return;
                }
                var button = document.createElement("button");
                button.type = "button";
                button.className = "summon-history-card";
                button.dataset.rarity = String(card.rarity);
                button.setAttribute("aria-label", "查看 " + displayName(card) + " 的卡面");
                button.addEventListener("click", function () {
                    openCardViewer(card, false, cards);
                });
                var image = document.createElement("img");
                image.src = cardIconUrl(card, false);
                image.alt = "";
                image.loading = "lazy";
                image.decoding = "async";
                var rarity = document.createElement("span");
                rarity.textContent = starText(card.rarity);
                button.appendChild(image);
                button.appendChild(rarity);
                if (item.isNew) {
                    var newMark = document.createElement("b");
                    newMark.textContent = "NEW";
                    button.appendChild(newMark);
                }
                cardList.appendChild(button);
            });
            article.appendChild(cardList);
            list.appendChild(article);
        });
    }

    function openSummonHistory() {
        var dialog = byId("summonHistory");
        renderSummonHistory();
        if (!dialog.open) {
            dialog.showModal();
        }
        byId("closeSummonHistory").focus();
    }

    function closeSummonHistory() {
        var dialog = byId("summonHistory");
        if (dialog.open) {
            dialog.close();
        }
    }

    function clearSummonHistory() {
        if (!state.record.history.length || !window.confirm("确定清空全部本地抽卡历史吗？累计召唤和已遇卡片统计会保留。")) {
            return;
        }
        state.record.history = [];
        writeRecord();
        renderSummonHistory();
    }

    function resetSummonRecord() {
        var hasRecord = state.record.total > 0
            || state.record.fiveStars > 0
            || state.record.owned.length > 0
            || state.record.history.length > 0;
        if (!hasRecord || !window.confirm("确定重置全部召唤记录吗？抽卡历史、累计召唤、★5 次数和已遇卡片都会被清除，且无法撤销。")) {
            return;
        }
        state.record = { total: 0, fiveStars: 0, owned: [], history: [] };
        try {
            window.localStorage.removeItem(recordKey);
        } catch (error) {
            // The in-memory record is still reset when localStorage is unavailable.
        }
        updateRecordDisplay();
        renderSummonHistory();
    }

    function renderResults(results) {
        var cards = results.map(function (result) { return result.card; });
        byId("summonResultOverlay").hidden = false;
        var grid = byId("resultsGrid");
        clearElement(grid);
        grid.classList.remove("results-grid-empty");
        results.forEach(function (result, index) {
            grid.appendChild(createDrawCard(result, index, cards));
        });
        var fiveStarCount = cards.filter(function (card) { return card.rarity === 5; }).length;
        var newCount = results.filter(function (result) { return result.isNew; }).length;
        byId("resultStatus").textContent = fiveStarCount > 0
            ? "召唤完成。与 " + cards.length + " 张角色卡相遇，其中 ★5 共 " + fiveStarCount + " 张。"
            : "召唤完成。与 " + cards.length + " 张角色卡相遇。";
        byId("resultVoiceLine").lang = "ja";
        byId("resultVoiceLine").textContent = fiveStarCount > 0
            ? "す、すごかったです！ 次回もがんばりますっ！"
            : "次回もがんばりますっ！ またいつでも来てくださいね！";
        byId("duplicateCardCount").textContent = String(cards.length - newCount);
        byId("newCardCount").textContent = String(newCount);
        byId("resultDrawCount").textContent = String(cards.length);
        byId("resultRewards").hidden = false;
        byId("drawAgain").hidden = false;
        byId("drawAgain").textContent = cards.length === 10 ? "再召唤 10 次" : "再召唤 1 次";
    }

    function setSummonButtonsDisabled(disabled) {
        byId("drawOne").disabled = disabled;
        byId("drawTen").disabled = disabled;
        byId("drawAgain").disabled = disabled;
        byId("includeOriginalCharacters").disabled = disabled;
    }

    function stopSummonAudio() {
        if (state.resultVoiceTimer) {
            window.clearTimeout(state.resultVoiceTimer);
            state.resultVoiceTimer = null;
        }
        [state.roomVoice, state.claireCue, state.titleVoice, state.resultVoice, state.summonBgm].forEach(function (audio) {
            if (!audio) {
                return;
            }
            audio.pause();
            try {
                audio.currentTime = 0;
            } catch (error) {
                return;
            }
        });
    }

    function playSummonAudio(slot, source, volume, loop) {
        if (!state.soundEnabled) {
            return Promise.resolve(false);
        }

        try {
            if (!state[slot]) {
                state[slot] = new Audio();
                state[slot].preload = "auto";
            }
            var audio = state[slot];
            audio.pause();
            audio.src = source;
            audio.loop = Boolean(loop);
            audio.volume = volume;
            var playback = audio.play();
            if (playback && typeof playback.catch === "function") {
                return playback.then(function () { return true; }).catch(function (error) {
                    // Shared elements are reused across pulls, so a fresh pull
                    // can start (and pause) the same element while the previous
                    // play is still settling. The browser then rejects the new
                    // request with "interrupted by a new load request" and the
                    // cue (Claire's result voice) is silently lost. Retry once
                    // on the next tick instead of swallowing it.
                    if (error && (error.name === "NotAllowedError" || error.name === "AbortError")) {
                        var retry = audio;
                        retry.currentTime = 0;
                        var retried = retry.play();
                        if (retried && typeof retried.catch === "function") {
                            return retried.then(function () { return true; }).catch(function () { return false; });
                        }
                        return true;
                    }
                    return false;
                });
            }
            return Promise.resolve(true);
        } catch (error) {
            return Promise.resolve(false);
        }
    }

    function stopSummonBgm() {
        if (!state.summonBgm) {
            return;
        }
        state.summonBgm.pause();
        try {
            state.summonBgm.currentTime = 0;
        } catch (error) {
            return;
        }
    }

    function playSummonBgm() {
        // 原版召唤流程中，克蕾尔台词和卡面演出共用同一段循环 BGM。
        return playSummonAudio("summonBgm", summonAudioFiles.summonBgm, 0.38, true);
    }

    function playGachaBgm() {
        return playSummonAudio("summonBgm", summonAudioFiles.gachaBgm, 0.28, true);
    }

    function playResultVoice(hasFiveStar) {
        // 原版结算语音只有两档：出了 ★5 用 voice_gacha_003，其余（含 ★4）一律
        // voice_gacha_004。两个 cue 都在 Voice_Original_006。
        //
        // GachaResult.PlayResultVoice 的判据是 CharaListDB.m_Rare >= 4，而
        // CharacterList.m_Rare 是 0 基的：整张表只取 2/3/4 三个值（各 89 / 452 /
        // 740 条，没有 5），也就是 ★3/★4/★5。所以 m_Rare>=4 就是「只有 ★5」，
        // 不是「★4 及以上」。这里原先照字面写成了 rarity >= 4，而本页的
        // card.rarity 是 1 基的（别处判 ★5 都写 === 5），于是单出 ★4 也会播那句
        // 「す、すごかったです！」——同一屏的字幕却是按 fiveStarCount 选的，两边
        // 对不上。
        playSummonAudio("resultVoice", hasFiveStar ? "audio/gacha/voice_gacha_003.mp3" : "audio/gacha/voice_gacha_004.mp3", 0.98, false);
    }

    function playTitleVoice(card) {
        var cue = titleVoiceCueByTitleId[card.titleId];
        if (!cue) {
            return Promise.resolve(false);
        }
        return playSummonAudio("titleVoice", summonAudioFiles.titleVoicePrefix + cue + ".mp3", 0.94, false).then(function (started) {
            var audio = state.titleVoice;
            if (!started || !audio) {
                return false;
            }
            return new Promise(function (resolve) {
                var settled = false;
                var timer = window.setTimeout(function () { finish(true); }, 12000);

                function finish(completed) {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    window.clearTimeout(timer);
                    audio.removeEventListener("ended", onEnded);
                    audio.removeEventListener("pause", onPause);
                    audio.removeEventListener("error", onError);
                    resolve(completed);
                }

                function onEnded() { finish(true); }
                function onPause() { finish(false); }
                function onError() { finish(false); }

                audio.addEventListener("ended", onEnded);
                audio.addEventListener("pause", onPause);
                audio.addEventListener("error", onError);
                if (audio.ended) {
                    finish(true);
                }
            });
        });
    }

    function roomGreetingForHour(hour) {
        if (hour >= 5 && hour < 11) {
            return { source: summonAudioFiles.roomMorningVoice, text: "早上好。欢迎来到召唤馆。" };
        }
        if (hour >= 11 && hour < 18) {
            return { source: summonAudioFiles.roomDayVoice, text: "欢迎来到召唤馆。今天也请多关照。" };
        }
        return { source: summonAudioFiles.roomNightVoice, text: "晚上好。欢迎来到召唤馆。" };
    }

    function playRoomGreeting() {
        var greeting = roomGreetingForHour(new Date().getHours());
        byId("roomGreetingLine").textContent = greeting.text;
        return playSummonAudio("roomVoice", greeting.source, 0.92, false).then(function (started) {
            if (started) {
                state.roomGreetingPlayed = true;
            }
            return started;
        });
    }

    function runSummonAnimation(results, done) {
        var cards = results.map(function (result) { return result.card; });
        var stage = byId("summonStage");
        var highestRarity = Math.max.apply(null, cards.map(function (card) { return card.rarity; }));
        var finished = false;
        var waiters = [];
        var runId = String(Date.now()) + "-" + String(randomUnit());
        var revealImage = byId("summonRevealCard");
        var featureImage = byId("summonFeatureArt");
        var characterStand = byId("summonCharacterStand");
        var newResults = results.filter(function (result) {
            return result.isNew && result.card.rarity !== 5;
        });
        var protectedFiveIndexes = results.reduce(function (indexes, result, index) {
            if (result.isNew && result.card.rarity === 5) {
                indexes.push(index);
            }
            return indexes;
        }, []);
        var protectedFiveShownIndexes = new Set();
        var protectedFivePlaying = false;
        var skipRequested = false;

        stage.dataset.summonRun = runId;
        stage.hidden = false;
        stage.className = "summon-stage rarity-" + highestRarity + " is-active phase-host";
        stage.setAttribute("aria-hidden", "false");
        if (!stage.open) {
            stage.showModal();
        }
        byId("skipSummon").focus();
        byId("summonStageText").textContent = "欢迎来到召唤馆。让星光回应你的呼唤吧。";
        byId("summonVoiceLine").textContent = "クレア";
        byId("summonRevealRarity").textContent = "";
        byId("summonRevealProgress").textContent = "";
        revealImage.hidden = true;
        featureImage.hidden = true;
        characterStand.hidden = true;
        byId("summonResultOverlay").hidden = true;
        document.body.classList.add("summon-playing");
        var keyRendererReady = loadGachaKeyRenderer();
        playSummonBgm();

        function isActive() {
            return !finished && stage.dataset.summonRun === runId;
        }

        function wait(delay) {
            if (skipRequested && !protectedFivePlaying && hasPendingProtectedFive()) {
                return Promise.resolve(isActive());
            }
            return new Promise(function (resolve) {
                var settled = false;
                var timer = window.setTimeout(function () {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    waiters = waiters.filter(function (waiter) { return waiter !== cancel; });
                    resolve(isActive());
                }, delay);

                function cancel(continueRun) {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    window.clearTimeout(timer);
                    resolve(Boolean(continueRun) && isActive());
                }

                waiters.push(cancel);
            });
        }

        function cancelWaits() {
            var pending = waiters.slice();
            waiters = [];
            pending.forEach(function (cancel) { cancel(false); });
        }

        function releaseWaits() {
            var pending = waiters.slice();
            waiters = [];
            pending.forEach(function (cancel) { cancel(true); });
        }

        function setStagePhase(card, phaseNames) {
            if (!isActive()) {
                return false;
            }
            stage.className = "summon-stage rarity-" + card.rarity + " class-" + card.class + " is-active " + phaseNames;
            updateGachaKeyPhase(phaseNames);
            return true;
        }

        function hasPendingProtectedFive() {
            return protectedFiveIndexes.some(function (index) {
                return !protectedFiveShownIndexes.has(index);
            });
        }

        function nextProtectedFiveIndex() {
            return protectedFiveIndexes.find(function (index) {
                return !protectedFiveShownIndexes.has(index);
            });
        }

        function prepareSequenceImage(sources, alt, priority) {
            return new Promise(function (resolve) {
                var sourceIndex = 0;

                function tryNextSource() {
                    if (!isActive()) {
                        resolve({ source: "", alt: alt });
                        return;
                    }
                    if (sourceIndex >= sources.length) {
                        resolve({ source: "", alt: alt });
                        return;
                    }

                    var probe = new Image();
                    probe.decoding = "async";
                    probe.fetchPriority = priority || "auto";
                    probe.onload = function () {
                        if (probe.decode) {
                            probe.decode().catch(function () { return; }).then(function () {
                                resolve({ source: probe.src, alt: alt });
                            });
                        } else {
                            resolve({ source: probe.src, alt: alt });
                        }
                    };
                    probe.onerror = function () {
                        sourceIndex += 1;
                        tryNextSource();
                    };
                    probe.src = sources[sourceIndex];
                }

                tryNextSource();
            });
        }

        function commitSequenceImage(image, prepared) {
            if (!isActive() || !prepared) {
                return false;
            }
            if (!prepared.source) {
                image.hidden = true;
                return true;
            }
            image.src = prepared.source;
            image.alt = prepared.alt;
            image.hidden = false;
            return true;
        }

        function prepareCard(card, priority) {
            return prepareSequenceImage([
                cardArtUrl(card, false, true),
                cardArtUrl(card, false, false)
            ], displayName(card) + "卡面", priority).then(function (reveal) {
                return { reveal: reveal };
            });
        }

        async function showNewCharacters() {
            if (!isActive() || newResults.length === 0) {
                return isActive();
            }

            var hostCard = newResults[0].card;
            setStagePhase(hostCard, "phase-room phase-new-host");
            byId("summonStageText").textContent = "接下来，请让我介绍新加入的伙伴。";
            byId("summonVoiceLine").textContent = "よろしくお願いします。";
            if (!await wait(2500)) {
                return false;
            }

            for (var index = 0; index < newResults.length; index++) {
                var card = newResults[index].card;
                setStagePhase(card, "phase-room");
                characterStand.hidden = true;
                var standReady = prepareSequenceImage([
                cardStandUrl(card, false),
                cardArtUrl(card, false, true),
                cardArtUrl(card, false, false)
                ], displayName(card) + "透明立绘", "high");
                if (!await wait(460)) {
                    return false;
                }
                var preparedStand = await standReady;
                if (!commitSequenceImage(characterStand, preparedStand)) {
                    return false;
                }
                setStagePhase(card, "phase-character");
                byId("summonStageText").textContent = displayName(card) + " · " + displayTitle(card);
                byId("summonVoiceLine").textContent = "NEW  " + (index + 1) + " / " + newResults.length;
                if (!await wait(3000)) {
                    return false;
                }
                setStagePhase(card, "phase-room");
                if (!await wait(620)) {
                    return false;
                }
                characterStand.hidden = true;
            }
            return true;
        }

        async function showImmediateFiveStar(card) {
            setStagePhase(card, "phase-room");
            characterStand.hidden = true;
            var standReady = prepareSequenceImage([
                cardStandUrl(card, false),
                cardArtUrl(card, false, true),
                cardArtUrl(card, false, false)
            ], displayName(card) + "透明立绘", "high");
            byId("summonStageText").textContent = displayName(card) + " · " + displayTitle(card);
            byId("summonVoiceLine").textContent = "";
            if (!await wait(520)) {
                return false;
            }
            var preparedStand = await standReady;
            if (!commitSequenceImage(characterStand, preparedStand)) {
                return false;
            }
            setStagePhase(card, "phase-character");
            byId("summonVoiceLine").textContent = "NEW  ★5";
            if (!await wait(3600)) {
                return false;
            }
            setStagePhase(card, "phase-room");
            if (!await wait(620)) {
                return false;
            }
            characterStand.hidden = true;
            return true;
        }

        async function playSequence() {
            var preparedCard = prepareCard(cards[0], "high");
            var preparedIndex = 0;

            if (!await wait(1400)) {
                return;
            }
            // Do not enter the key sequence until the official GLB is ready.
            // The old bitmap fallback contained the room background and became
            // bright diagonal strips when squeezed into a depth-facing pose.
            await keyRendererReady;
            if (!isActive()) {
                return;
            }
            setStagePhase(cards[0], "phase-key-flight");
            byId("summonStageText").textContent = "";
            byId("summonVoiceLine").textContent = "";
            if (!await wait(1400)) {
                return;
            }
            setStagePhase(cards[0], "phase-key-focus");
            if (!await wait(1900)) {
                return;
            }
            setStagePhase(cards[0], "phase-key-lock");
            if (!await wait(1867)) {
                return;
            }

            for (var index = 0; index < cards.length; index++) {
                if (skipRequested && hasPendingProtectedFive()) {
                    var nextProtectedIndex = nextProtectedFiveIndex();
                    if (index !== nextProtectedIndex) {
                        index = nextProtectedIndex;
                    }
                }
                var card = cards[index];
                var isFiveStar = card.rarity === 5;
                protectedFivePlaying = protectedFiveIndexes.indexOf(index) !== -1 && !protectedFiveShownIndexes.has(index);
                if (preparedIndex !== index) {
                    preparedCard = prepareCard(card, "high");
                    preparedIndex = index;
                }
                setStagePhase(card, "phase-room");
                revealImage.hidden = true;
                featureImage.hidden = true;
                characterStand.hidden = true;
                byId("summonStageText").textContent = "第 " + (index + 1) + " 次召唤";
                byId("summonVoiceLine").textContent = "";
                byId("summonRevealProgress").textContent = (index + 1) + " / " + cards.length;
                if (!await wait(520)) {
                    return;
                }
                if (skipRequested && !protectedFivePlaying && hasPendingProtectedFive()) {
                    var nextProtectedAfterRoom = nextProtectedFiveIndex();
                    preparedIndex = nextProtectedAfterRoom;
                    preparedCard = prepareCard(cards[nextProtectedAfterRoom], "high");
                    index = nextProtectedAfterRoom - 1;
                    continue;
                }

                var prepared = await preparedCard;
                if (!isActive() || !commitSequenceImage(revealImage, prepared.reveal)) {
                    return;
                }
                preparedCard = index + 1 < cards.length
                    ? prepareCard(cards[index + 1], "auto")
                    : null;
                preparedIndex = index + 1;

                setStagePhase(card, "phase-sigil");
                if (!await wait(1150)) {
                    return;
                }
                if (skipRequested && !protectedFivePlaying && hasPendingProtectedFive()) {
                    var nextProtectedAfterSigil = nextProtectedFiveIndex();
                    preparedIndex = nextProtectedAfterSigil;
                    preparedCard = prepareCard(cards[nextProtectedAfterSigil], "high");
                    index = nextProtectedAfterSigil - 1;
                    continue;
                }
                setStagePhase(card, "phase-sigil phase-upgrade");
                if (!await wait(isFiveStar ? 1150 : 900)) {
                    return;
                }
                if (skipRequested && !protectedFivePlaying && hasPendingProtectedFive()) {
                    var nextProtectedAfterUpgrade = nextProtectedFiveIndex();
                    preparedIndex = nextProtectedAfterUpgrade;
                    preparedCard = prepareCard(cards[nextProtectedAfterUpgrade], "high");
                    index = nextProtectedAfterUpgrade - 1;
                    continue;
                }

                if (isFiveStar) {
                    setStagePhase(card, "phase-sigil phase-upgrade phase-five-claire");
                    byId("summonStageText").textContent = "《" + displayTitle(card) + "》";
                    byId("summonVoiceLine").textContent = "クレア";
                    var titleVoiceCompleted = await playTitleVoice(card);
                    if (!isActive()) {
                        return;
                    }
                    if (!titleVoiceCompleted && !await wait(3000)) {
                        return;
                    }
                    if (titleVoiceCompleted && !await wait(280)) {
                        return;
                    }

                }

                featureImage.hidden = true;
                setStagePhase(card, "phase-sigil phase-upgrade phase-class-feature");
                byId("summonStageText").textContent = "";
                byId("summonVoiceLine").textContent = "";
                if (!await wait(isFiveStar ? 2400 : (card.rarity === 4 ? 1900 : 1500))) {
                    return;
                }

                setStagePhase(card, "phase-reveal");
                byId("summonStageText").textContent = displayName(card) + " · " + displayTitle(card);
                if (!await wait(isFiveStar ? 2800 : 2200)) {
                    return;
                }
                setStagePhase(card, "phase-card-exit");
                if (!await wait(680)) {
                    return;
                }
                revealImage.hidden = true;
                featureImage.hidden = true;
                if (isFiveStar && results[index].isNew) {
                    if (!await showImmediateFiveStar(card)) {
                        return;
                    }
                }
                if (protectedFiveIndexes.indexOf(index) !== -1) {
                    protectedFiveShownIndexes.add(index);
                    protectedFivePlaying = false;
                }
                if (skipRequested && !hasPendingProtectedFive()) {
                    finish(true);
                    return;
                }
            }

            if (await showNewCharacters()) {
                finish(false);
            }
        }

        function finish(wasSkipped) {
            if (finished) {
                return;
            }
            finished = true;
            cancelWaits();
            revealImage.hidden = true;
            featureImage.hidden = true;
            characterStand.hidden = true;
            stopSummonAudio();
            stage.className = "summon-stage is-active phase-result";
            updateGachaKeyPhase("");
            state.finishSummonAnimation = null;
            done();
        }

        function requestSkip() {
            if (hasPendingProtectedFive()) {
                skipRequested = true;
                if (!protectedFivePlaying) {
                    releaseWaits();
                }
                return;
            }
            finish(true);
        }

        state.finishSummonAnimation = requestSkip;
        playSequence().catch(function () {
            if (isActive()) {
                finish(false);
            }
        });
    }

    function performSummon(count) {
        if (state.summonInProgress) {
            return;
        }
        stopSummonAudio();
        state.summonInProgress = true;
        setSummonButtonsDisabled(true);
        state.lastDrawCount = count;
        byId("resultStatus").textContent = "正在翻开圣典……";

        var results = [];
        var debugOptions = localDebugSummonOptions();
        for (var index = 0; index < count; index++) {
            var guaranteed = count === 10 && index === count - 1;
            var rarity = debugOptions && index < debugOptions.fiveStarCount
                ? 5
                : (debugOptions && debugOptions.rarity ? debugOptions.rarity : chooseRarity(guaranteed));
            var debugPool = debugOptions && debugOptions.classType !== null
                ? state.pools[rarity].filter(function (card) { return card.class === debugOptions.classType; })
                : state.pools[rarity];
            if (debugOptions) {
                var unusedDebugCards = debugPool.filter(function (card) {
                    return !results.some(function (result) { return result.id === card.id; });
                });
                if (unusedDebugCards.length) {
                    debugPool = unusedDebugCards;
                }
            }
            results.push(pickRandom(debugPool.length ? debugPool : state.pools[rarity]));
        }

        var previewOwnedSet = new Set(state.record.owned);
        var resultItems = results.map(function (card) {
            var isNew = !previewOwnedSet.has(card.id);
            previewOwnedSet.add(card.id);
            return { card: card, isNew: isNew };
        });

        runSummonAnimation(resultItems, function () {
            var ownedSet = new Set(state.record.owned);
            resultItems.forEach(function (result) {
                var card = result.card;
                ownedSet.add(card.id);
                if (card.rarity === 5) {
                    state.record.fiveStars += 1;
                }
            });
            state.record.total += results.length;
            state.record.owned = Array.from(ownedSet);
            state.record.history.unshift({
                at: new Date().toISOString(),
                cards: resultItems.map(function (result) {
                    return { id: result.card.id, isNew: result.isNew };
                })
            });
            state.record.history = state.record.history.slice(0, 30);
            writeRecord();
            updateRecordDisplay();
            renderResults(resultItems);
            playGachaBgm();
            playResultVoice(results.some(function (card) { return card.rarity === 5; }));
            state.summonInProgress = false;
            setSummonButtonsDisabled(false);
            byId("resultsTitle").focus({ preventScroll: true });
        });
    }

    function closeSummonResult() {
        var stage = byId("summonStage");
        stopSummonAudio();
        byId("summonResultOverlay").hidden = true;
        if (stage.open) {
            stage.close();
        }
        stage.hidden = true;
        stage.setAttribute("aria-hidden", "true");
        document.body.classList.remove("summon-playing");
        playGachaBgm();
        byId("drawTen").focus({ preventScroll: true });
    }

    function normalizeSearch(value) {
        return String(value || "").toLocaleLowerCase().replace(/\s+/g, "");
    }

    function rebuildActivePool() {
        state.activeCards = data.cards.filter(function (card) {
            return state.includeOriginal || card.titleId !== originalTitleType;
        });
        state.pools = { 3: [], 4: [], 5: [] };
        state.activeCards.forEach(function (card) {
            if (state.pools[card.rarity]) {
                state.pools[card.rarity].push(card);
            }
        });

        var characterCount = new Set(state.activeCards.map(function (card) { return card.namedType; })).size;
        var titleCount = new Set(state.activeCards.map(function (card) { return card.titleId; })).size;
        var originalCardCount = data.meta.originalCardCount || data.cards.filter(function (card) {
            return card.titleId === originalTitleType;
        }).length;

        byId("cardCount").textContent = String(state.activeCards.length);
        byId("characterCount").textContent = String(characterCount);
        byId("titleCount").textContent = String(titleCount);
        byId("includeOriginalCharacters").checked = state.includeOriginal;
        byId("originalPoolStatus").textContent = state.includeOriginal
            ? "已加入 " + originalCardCount + " 张原创角色卡"
            : "当前未加入 " + originalCardCount + " 张原创角色卡";
        byId("summonTitle").textContent = state.includeOriginal
            ? "收录全部角色卡，包括《琪拉拉幻想曲》原创角色；十连最后一张必定为 ★4 或以上。"
            : "默认收录全部非原创角色卡，十连最后一张必定为 ★4 或以上。";
        byId("catalogDescription").textContent = state.includeOriginal
            ? "可以检索全部 " + state.activeCards.length + " 张角色卡，包括原创角色。"
            : "可以检索全部 " + state.activeCards.length + " 张非原创角色卡，不需要先抽到。";

        populateTitleFilter();
        state.catalogPage = 1;
        renderCatalog();
    }

    function filteredCards() {
        var query = normalizeSearch(byId("searchInput").value);
        var titleId = byId("titleFilter").value;
        var rarity = byId("rarityFilter").value;
        return state.activeCards.filter(function (card) {
            if (titleId && String(card.titleId) !== titleId) {
                return false;
            }
            if (rarity && String(card.rarity) !== rarity) {
                return false;
            }
            if (!query) {
                return true;
            }
            var haystack = normalizeSearch([
                card.name,
                card.nameZh,
                card.nameEn,
                card.character,
                card.characterZh,
                card.characterEn,
                card.title,
                card.titleZh,
                card.titleEn
            ].join(" "));
            return haystack.indexOf(query) !== -1;
        });
    }

    function paginationPages(current, total) {
        var pages = [];
        for (var page = 1; page <= total; page++) {
            if (page === 1 || page === total || Math.abs(page - current) <= 2) {
                pages.push(page);
            }
        }
        return pages;
    }

    function renderPagination(totalPages) {
        var navigation = byId("catalogPagination");
        clearElement(navigation);
        if (totalPages <= 1) {
            return;
        }

        function addButton(label, page, disabled, current) {
            var button = document.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.disabled = disabled;
            if (current) {
                button.classList.add("is-current");
                button.setAttribute("aria-current", "page");
            }
            button.setAttribute("aria-label", label === "上一页" || label === "下一页" ? label : "第 " + page + " 页");
            button.addEventListener("click", function () {
                state.catalogPage = page;
                renderCatalog();
                byId("catalogTitle").scrollIntoView({ behavior: "smooth", block: "start" });
            });
            navigation.appendChild(button);
        }

        addButton("上一页", state.catalogPage - 1, state.catalogPage === 1, false);
        var pages = paginationPages(state.catalogPage, totalPages);
        pages.forEach(function (page, index) {
            if (index > 0 && page - pages[index - 1] > 1) {
                var ellipsis = document.createElement("span");
                ellipsis.textContent = "…";
                navigation.appendChild(ellipsis);
            }
            addButton(String(page), page, false, page === state.catalogPage);
        });
        addButton("下一页", state.catalogPage + 1, state.catalogPage === totalPages, false);
    }

    function renderCatalog() {
        var cards = filteredCards();
        var totalPages = Math.max(1, Math.ceil(cards.length / pageSize));
        state.catalogPage = Math.min(state.catalogPage, totalPages);
        var start = (state.catalogPage - 1) * pageSize;
        var visibleCards = cards.slice(start, start + pageSize);
        var grid = byId("catalogGrid");
        clearElement(grid);

        if (visibleCards.length === 0) {
            var empty = document.createElement("p");
            empty.className = "catalog-empty";
            empty.textContent = "没有找到符合条件的角色卡。";
            grid.appendChild(empty);
        } else {
            visibleCards.forEach(function (card) {
                grid.appendChild(createCatalogCard(card, cards));
            });
        }

        byId("poolCount").textContent = "找到 " + cards.length + " 张卡片 · 第 " + state.catalogPage + " / " + totalPages + " 页";
        renderPagination(totalPages);
    }

    function populateTitleFilter() {
        var select = byId("titleFilter");
        var selectedValue = select.value;
        var activeTitleIds = new Set(state.activeCards.map(function (card) { return card.titleId; }));
        clearElement(select);
        var allOption = document.createElement("option");
        allOption.value = "";
        allOption.textContent = "全部作品";
        select.appendChild(allOption);
        data.titles.filter(function (title) {
            return activeTitleIds.has(title.id);
        }).forEach(function (title) {
            var option = document.createElement("option");
            option.value = title.id;
            option.textContent = state.language === "ja"
                ? title.name || title.nameZh || title.nameEn
                : state.language === "en"
                    ? title.nameEn || title.name || title.nameZh
                    : title.nameZh || title.name || title.nameEn;
            select.appendChild(option);
        });
        if (Array.from(select.options).some(function (option) { return option.value === selectedValue; })) {
            select.value = selectedValue;
        }
    }

    function init() {
        if (!data || !Array.isArray(data.cards) || data.cards.length === 0) {
            byId("resultStatus").textContent = "卡池数据加载失败，请刷新页面重试。";
            setSummonButtonsDisabled(true);
            return;
        }

        updateRecordDisplay();
        updateSoundButton();
        byId("languageFilter").value = state.language;
        rebuildActivePool();
        Promise.all([playGachaBgm(), playRoomGreeting()]).then(function (started) {
            var bgmStarted = started[0];
            var greetingStarted = started[1];
            if ((bgmStarted && greetingStarted) || !state.soundEnabled) {
                return;
            }

            var unlockRoomAudio = function (event) {
                document.removeEventListener("pointerdown", unlockRoomAudio);
                document.removeEventListener("keydown", unlockRoomAudio);
                var target = event.target;
                var handlesAudioDirectly = target && target.closest
                    && target.closest("#drawOne, #drawTen, #drawAgain, #soundToggle");
                if (!state.soundEnabled || state.summonInProgress || handlesAudioDirectly) {
                    return;
                }
                if (!bgmStarted) {
                    playGachaBgm();
                }
                if (!greetingStarted && !state.roomGreetingPlayed) {
                    playRoomGreeting();
                }
            };
            document.addEventListener("pointerdown", unlockRoomAudio);
            document.addEventListener("keydown", unlockRoomAudio);
        });

        byId("drawOne").addEventListener("click", function () { performSummon(1); });
        byId("drawTen").addEventListener("click", function () { performSummon(10); });
        byId("includeOriginalCharacters").addEventListener("change", function (event) {
            state.includeOriginal = event.currentTarget.checked;
            writeIncludeOriginalPreference();
            rebuildActivePool();
        });
        byId("soundToggle").addEventListener("click", function () {
            state.soundEnabled = !state.soundEnabled;
            if (!state.soundEnabled) {
                stopSummonAudio();
            } else if (state.summonInProgress) {
                playSummonBgm();
            } else {
                playGachaBgm();
                if (!state.roomGreetingPlayed) {
                    playRoomGreeting();
                }
            }
            writeSoundPreference();
            updateSoundButton();
        });
        byId("drawAgain").addEventListener("click", function () {
            performSummon(state.lastDrawCount || 1);
        });
        byId("openSummonHistory").addEventListener("click", openSummonHistory);
        byId("closeSummonHistory").addEventListener("click", closeSummonHistory);
        byId("doneSummonHistory").addEventListener("click", closeSummonHistory);
        byId("clearSummonHistory").addEventListener("click", clearSummonHistory);
        byId("resetSummonRecord").addEventListener("click", resetSummonRecord);
        byId("closeSummonResult").addEventListener("click", closeSummonResult);
        byId("skipSummon").addEventListener("click", function () {
            if (state.finishSummonAnimation) {
                state.finishSummonAnimation(true);
            }
        });
        byId("summonStage").addEventListener("cancel", function (event) {
            event.preventDefault();
            if (state.finishSummonAnimation) {
                state.finishSummonAnimation(true);
            } else if (!state.summonInProgress) {
                closeSummonResult();
            }
        });
        byId("viewerClose").addEventListener("click", closeCardViewer);
        byId("cardViewer").addEventListener("click", function (event) {
            if (event.target === byId("cardViewer")) {
                closeCardViewer();
            }
        });
        byId("cardViewer").addEventListener("close", function () {
            document.body.classList.remove("viewer-open");
        });
        byId("viewerBase").addEventListener("click", function () {
            state.viewer.evolved = false;
            updateViewer();
        });
        byId("viewerEvolved").addEventListener("click", function () {
            state.viewer.evolved = true;
            updateViewer();
        });
        byId("viewerCardArt").addEventListener("click", function () {
            state.viewer.mode = "card";
            updateViewer();
        });
        byId("viewerStand").addEventListener("click", function () {
            state.viewer.mode = "stand";
            updateViewer();
        });
        byId("viewerFullIllustration").addEventListener("click", function () {
            state.viewer.mode = "full";
            updateViewer();
        });
        byId("viewerPrevious").addEventListener("click", function () { moveViewer(-1); });
        byId("viewerNext").addEventListener("click", function () { moveViewer(1); });
        byId("cardViewer").addEventListener("keydown", function (event) {
            if (event.key === "ArrowLeft") {
                event.preventDefault();
                moveViewer(-1);
            } else if (event.key === "ArrowRight") {
                event.preventDefault();
                moveViewer(1);
            }
        });
        byId("catalogFilters").addEventListener("submit", function (event) { event.preventDefault(); });
        byId("clearFilters").addEventListener("click", function () {
            byId("searchInput").value = "";
            byId("titleFilter").value = "";
            byId("rarityFilter").value = "";
            state.catalogPage = 1;
            renderCatalog();
            byId("searchInput").focus();
        });
        byId("languageFilter").addEventListener("change", function (event) {
            state.language = event.currentTarget.value;
            writeLanguagePreference();
            populateTitleFilter();
            renderCatalog();
            renderSummonHistory();
            if (state.viewer.card) {
                updateViewer();
            }
        });
        ["searchInput", "titleFilter", "rarityFilter"].forEach(function (id) {
            var eventName = id === "searchInput" ? "input" : "change";
            byId(id).addEventListener(eventName, function () {
                state.catalogPage = 1;
                renderCatalog();
            });
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
        init();
    }
})();
