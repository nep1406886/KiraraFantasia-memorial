var thumbnailMap = {
    "none": "imgs/kirara.png",
    "kirara": "imgs/kirara.png",
    "lamp": "imgs/lamp.png",
    "match": "imgs/match.png",
    "maintenance": "imgs/maintenance.png",
    "kanna": "imgs/kanna.png",
    "clea": "imgs/clea.png",
    "leine": "imgs/leine.png",
    "cork": "imgs/cork.png",
    "polka": "imgs/polka.png"
};



var elementsMap = {
    Sun: "imgs/Attribute_Sun.png",
    Moon: "imgs/Attribute_Moon.png",
    Fire: "imgs/Attribute_Fire.png",
    Water: "imgs/Attribute_Water.png",
    Wind: "imgs/Attribute_Wind.png",
    Earth: "imgs/Attribute_Earth.png",
    Gold: "imgs/Currency_gold_coin.png",
    Warrior: "imgs/Class_Warrior.png",
    Mage: "imgs/Class_Mage.png",
    Priest: "imgs/Class_Priest.png",
    Knight: "imgs/Class_Knight.png",
    Alchemist: "imgs/Class_Alchemist.png"
};

Vue.filter('addStars', function (str) {
    return str.replace(/3\*/g, "3★").replace(/4\*/g, "4★").replace(/5\*/g, "5★");
});
Vue.filter('elementImage', function (val) {
    return elementsMap[val];
});

Vue.directive('tooltip', {
    bind: function (el, binding) {
        $(el).tooltip({
            title: binding.value,
            placement: binding.arg,
            trigger: 'hover',
            html: true
        });
    },
    update: function (el, binding) {
        $(el).attr('data-original-title', binding.value);
    },
    unbind: function (el, binding) {
        $(el).tooltip('dispose');
    }
});

var vm = new Vue({
    el: '#app',
    data: {
        currentZone: "japan",
        japanTime: null,
        localTime: null,
        timersData: null,
        thumbChangeCount: 0,
        thumbChangeTime: 7,
        showHeader: true,
        columns: 3,
        filters: null,
        alerts: alertMessages,
        alertTypes: alertTypes,
        shutdownArtworks: []
    },
    computed: {
        visibleTimerColumns: function () {
            if (!this.timersData) {
                return [];
            }
            return this.timersData.filter(function (column) {
                return column.some(function (event) {
                    return event.visible;
                });
            });
        },
        orderedArtworks: function () {
            var firstRowIds = [
                "1654459077186183169",
                "1630463141850288128",
                "1630512055827730432"
            ];
            var firstRow = [];
            var remaining = [];

            this.shutdownArtworks.forEach(function (artwork) {
                if (firstRowIds.indexOf(artwork.id) !== -1) {
                    firstRow.push(artwork);
                } else {
                    remaining.push(artwork);
                }
            });
            firstRow.sort(function (a, b) {
                return firstRowIds.indexOf(a.id) - firstRowIds.indexOf(b.id);
            });

            return firstRow.concat(remaining);
        },
        featuredArtworks: function () {
            return this.orderedArtworks.slice(0, 3);
        },
        archiveArtworks: function () {
            return this.orderedArtworks.slice(3);
        }
    },
    methods: {
        changeTimezone: function () {
            var c, t, e, col, ev, timer, data = this.timersData;

            for (c = 0; c < data.length; c++) { // Check each column
                col = data[c];
                for (e = 0; e < col.length; e++) { // Check each event group
                    ev = col[e];
                    if (ev.type == "DailyQuest") {
                        ev.displayMode = this.currentZone;
                        continue;
                    }
                    for (t = 0; t < ev.timers.length; t++) { // Check each individual timer
                        timer = ev.timers[t];
                        timer.displayMode = this.currentZone;
                    }
                }
            }
        },

        // SETUP FUNCTIONS
        loadQueryParams: function () {
            let uri = window.location.search.substring(1);
            let params = new URLSearchParams(uri);

            let tz = params.get("tz");
            if (tz && (tz == "japan" || tz == "local")) {
                this.currentZone = tz;
            }

            if (params.get("header")) {
                this.showHeader = params.get("header").toLowerCase() != "false";
            }

            let cols = parseInt(params.get("columns"), 10);
            if (cols && !isNaN(cols) && cols > 0) {
                this.columns = cols;
            }

            let filters = {};
            if (params.get("type")) {
                filters.type = params.get("type").split(",").map(function (x) {
                    return x.trim().toLowerCase();
                });
            }
            if (params.get("id")) {
                filters.id = params.get("id").split(",").map(function (x) {
                    return parseInt(x, 10);
                });
            }
            if (params.get("title")) {
                filters.title = params.get("title").split(",").map(function (x) {
                    return x.trim().toLowerCase();
                });
            }
            if (Object.keys(filters).length > 0) {
                this.filters = filters;
            }
        },
        buildTimerData: function (data) {
            var res = [];
            var ev, i, col;
            var nowMoment = moment.tz("Asia/Tokyo");
            var localZone = moment.tz.guess();

            for (i = 1; i <= this.columns; i++) {
                res.push([]);
            }

            // Loops through all data to build the event timers
            for (i = 0; i < data.length; i++) {
                ev = data[i];
                if (!ev.priority) {
                    ev.priority = 0;
                }
                ev.bonusPriority = 0;
                ev.visible = true;

                if (ev.type == "DailyQuest") {
                    ev = this.buildDailyQuestTimer(ev, nowMoment);
                } else {
                    ev = this.buildEventGroup(ev, localZone);
                }

                if (this.filterCheck(ev, this.filters, i)) {
                    col = ev.column ? ev.column : 0;
                    if (col >= res.length) {
                        col = 0;
                    }
                    res[col].push(ev);
                }
            }

            // Sort timers and remove empty columns
            for (i = res.length; i--;) {
                if (res[i].length === 0) {
                    res.splice(i, 1);
                }
            }

            this.timersData = res;
        },
        buildDailyQuestTimer: function (ev, nowMoment) {
            ev.displayMode = "japan";
            ev.deadlineMoment = nowMoment.clone().endOf("day");
            ev.current = "";
            ev.deadline = "";
            ev.japanend = "";
            ev.localend = "";
            ev.visible = !ev.hide;
            return ev;
        },
        buildEventGroup: function (ev, localZone) {
            let evExtra, timer, e;

            // Default settings
            ev.expiration = 0;
            ev.nextTimer = "";
            ev.normalTimerIndex = 0;

            // Sets event image
            if (!ev.image) {
                ev.image = thumbnailMap.none;
            } else {
                // If array, image will rotate through all images listed every few seconds
                if (Array.isArray(ev.image)) {
                    ev.imageStep = Math.floor(Math.random() * ev.image.length);
                    ev.imageList = ev.image.map(function (x) {
                        return thumbnailMap.hasOwnProperty(x.toLowerCase()) ? thumbnailMap[x.toLowerCase()] : x;
                    });
                    ev.image = ev.imageList[ev.imageStep];
                } else if (thumbnailMap.hasOwnProperty(ev.image.toLowerCase())) {
                    ev.image = thumbnailMap[ev.image.toLowerCase()];
                }
            }

            // How long the event will still be displayed after all of its timers are finished
            evExtra = this.toDurationObject(ev.keepAfterFinished);

            // Create all individual timers
            for (e = 0; e < ev.timers.length; e++) {
                timer = this.buildEventTimer(ev.timers[e], ev, localZone, e, evExtra);
            }

            return ev;
        },
        buildEventTimer: function (timer, ev, localZone, normalTimerIndex, evExtra) {
            let timerExtra, startMoment, endMoment, expiration, extraDays = 0;

            // Default settings
            timer.visible = true;
            timer.progress = 0;
            timer.displayMode = "japan";

            // Sets timer type; Also adds start/end time for dates
            if (timer.hasOwnProperty("date")) {
                timer.start = timer.date + ", 0:00";
                timer.end = timer.date + ", 23:59";
                if (timer.days) {
                    extraDays = timer.days - 1;
                }
                timer.type = "date";
            } else if (ev.type == "WeekendBoss") {
                if (!timer.type) {
                    timer.type = "weekend";
                } else if (timer.type == "normal") {
                    ev.normalTimerIndex = normalTimerIndex;
                }
            } else {
                timer.type = "normal";
            }

            // Converts start/end moments to Japan time
            // var strFormat = "MMM Do<br>ddd, H:mm";
            //下面俩时间的显示
            var strFormat = "MMM D YYYY<br>ddd H:mm";
            moment.locale("zh-cn");
            startMoment = this.parseMoment(timer.start);
            endMoment = this.parseMoment(timer.end);
            if (ev.type == "Memorial") {
                strFormat = "YYYY年M月D日<br>ddd HH:mm";
            }
            if (extraDays > 0) {
                endMoment = endMoment.add(extraDays, "days");
            }

            timer.rawStart = startMoment._d.getTime();
            timer.rawEnd = endMoment._d.getTime();
            timer.operationDuration = this.timeDescription(timer.rawEnd - timer.rawStart, 4);
            timer.sinceStart = "";
            timer.sinceEnd = "";

            // Creates markers
            var marks = [];
            if (timer.hasOwnProperty("markers")) {
                let marker;
                for (var m = 0; m < timer.markers.length; m++) {
                    marker = this.createMarker(timer.markers[m], timer, localZone);
                    marks.push(marker);
                }
                timer.nextMarker = "";
            }
            if (timer.hasOwnProperty("banners")) {
                let marker;
                for (var m = 0; m < timer.banners.length; m++) {
                    marker = this.createMarker(timer.banners[m], timer, localZone);
                    if (marker.rawtime != timer.rawStart) {
                        marks.push(marker);
                    }
                }
                timer.nextMarker = "";
            }
            timer.markersInfo = marks;


            // Timer expiration = End Time + Timer's extra time
            timerExtra = this.toDurationObject(timer.keepAfterFinished);
            expiration = endMoment.clone().add(timerExtra);
            timer.expiration = expiration._d.getTime();

            // Event expiration = Last Timer's Expiration + Event's extra time
            expiration = expiration.add(evExtra)._d.getTime();
            if (expiration > ev.expiration) {
                ev.expiration = expiration;
            }

            // Stores date/time strings to display in timers
            if (timer.type == "date") {
                strFormat = "MMM Do<br>H:mm";
            } else if (timer.type == "weekend") {
                strFormat = "MMM Do";
            }
            timer.dateDisplay = {
                jpstart: startMoment.format(strFormat),
                localstart: startMoment.tz(localZone).format(strFormat),
                jpend: endMoment.format(strFormat),
                localend: endMoment.tz(localZone).format(strFormat),
                badgeStart: "",
                badgeEnd: "",
                barLabel: ""
            };
            return timer;
        },
        createMarker: function (marker, timer, localZone) {
            var markTime = this.parseMoment(marker.time);
            var tooltipFormat = "ddd, MMM Do, H:mm";
            var rawTime = markTime._d.getTime();
            var mark = {
                label: marker.title,
                type: marker.type || "star",
                jptime: markTime.format(tooltipFormat),
                localtime: markTime.tz(localZone).format(tooltipFormat),
                rawtime: rawTime,
                position: (rawTime - timer.rawStart) / (timer.rawEnd - timer.rawStart) * 100 + "%",
                started: false,
                tip: ""
            };
            return mark;
        },
        filterCheck: function (data, filters, id) {
            if (filters == null) {
                return true;
            }
            if (filters.hasOwnProperty("type")) {
                if (filters.type.indexOf(data.type.toLowerCase()) != -1) {
                    return true;
                }
            }
            if (filters.hasOwnProperty("title")) {
                let titles = Array.isArray(data.title) ? data.title : [data.title];
                let words = filters.title;
                for (let e = 0; e < titles.length; e++) {
                    for (let i = 0; i < words.length; i++) {
                        if (titles[e].toLowerCase().indexOf(words[i]) != -1) {
                            return true;
                        }
                    }
                }

            }
            if (filters.hasOwnProperty("id")) {
                if (filters.id.indexOf(id) != -1) {
                    return true;
                }
            }
            return false;
        },

        // UPDATE FUNCTIONS 切换时间 那里的显示数据
        updateClocks: function () {
            moment.locale("zh-cn");
            this.japanTime = moment().tz('Asia/Tokyo').format("dddd, MMMM Do YYYY, h:mm:ss");
            this.localTime = moment().format("dddd, MMMM Do YYYY, h:mm:ss");
            this.updateTimerData();
        },
        updateTimerData: function () {
            var c, e, ev, col, data = this.timersData;
            var nowMoment = moment.tz("Asia/Tokyo");
            var now = nowMoment._d.getTime();
            var localZone = moment.tz.guess();

            var changeThumbs = this.thumbChangeCount >= this.thumbChangeTime;
            this.thumbChangeCount += 1;
            if (changeThumbs) {
                this.thumbChangeCount = 0;
            }

            for (c = 0; c < data.length; c++) { // Check each column
                col = data[c];
                for (e = 0; e < col.length; e++) { // Check each event group
                    ev = col[e];
                    ev.bonusPriority = 0;
                    if (ev.type == "DailyQuest") {
                        this.updateDailyQuest(ev, now, nowMoment, localZone);
                    } else {
                        this.updateEventGroup(ev, now, changeThumbs);
                    }

                }

                col.sort(this.prioritySort);
            }
        },
        updateDailyQuest: function (ev, now, nowMoment, localZone) {
            let deadline = ev.deadlineMoment;
            if (deadline.date() != nowMoment.date()) {
                deadline = ev.deadlineMoment = nowMoment.clone().endOf("day");
            }
            ev.current = nowMoment.format("dddd").toLowerCase();

            ev.deadline = this.remainingTimeString(now, deadline._d.getTime(), 2);
            ev.japanend = deadline.format("MMM Do, H:mm");
            ev.localend = deadline.clone().tz(localZone).format("MMM Do, H:mm");
        },
        updateEventGroup: function (ev, now, changeThumbs) {
            var allExpired = true,
                nextDate = Infinity,
                nextType = "finished",
                lastDate = 0;

            // Check each individual timer
            for (var t = 0; t < ev.timers.length; t++) {
                var timer = ev.timers[t];
                if (this.updateEventTimer(timer, ev, now)) {
                    allExpired = false;
                }

                if (timer.rawStart > now && timer.rawStart < nextDate) {
                    nextDate = timer.rawStart;
                    nextType = "upcoming";
                }
                if (timer.rawEnd > now && timer.rawEnd < nextDate) {
                    nextDate = timer.rawEnd;
                    nextType = "ongoing";
                }
                if (timer.rawEnd > lastDate) {
                    lastDate = timer.rawEnd;
                }
            }

            // Updates text for LoginDays timers
            if (nextType == "finished") {
                ev.nextTimer = "已结束 " + this.remainingTimeString(now, lastDate, 2);
            } else if (nextType == "upcoming") {
                ev.nextTimer = "下一阶段将在 " + this.remainingTimeString(now, nextDate, 2) + " 后开始";
            } else {
                ev.nextTimer = "当前阶段还剩 " + this.remainingTimeString(now, nextDate, 2);
            }

            // Changes thumbnail for Event Group
            if (changeThumbs && ev.imageList) {
                ev.imageStep++;
                if (ev.imageStep >= ev.imageList.length) {
                    ev.imageStep = 0;
                }
                ev.image = ev.imageList[ev.imageStep];
            }

            // Check if event should be visible
            if (allExpired && now >= ev.expiration && (typeof ev.keepAfterFinished != "boolean" || ev.keepAfterFinished === false)) {
                ev.visible = false;
            }
        },
        updateEventTimer: function (timer, ev, now) {
            // Check if timer should be visible
            timer.visible = false;
            timer.progress = this.countProgress(now, timer.rawStart, timer.rawEnd);
            timer.sinceStart = now >= timer.rawStart
                ? this.timeDescription(now - timer.rawStart, 4)
                : this.timeDescription(timer.rawStart - now, 4) + " 后";
            timer.sinceEnd = now >= timer.rawEnd
                ? this.timeDescription(now - timer.rawEnd, 4)
                : this.timeDescription(timer.rawEnd - now, 4) + " 后";
            if (timer.keepAfterFinished === true || timer.type == "weekend" || timer.expiration > now) {
                timer.visible = true;

                // Write strings for progress bar dates according to state
                if (timer.progress <= 0) {
                    timer.dateDisplay.barLabel = this.remainingTimeString(now, timer.rawStart, 2) + " 后开始";
                    timer.dateDisplay.badgeStart = this.remainingTimeString(now, timer.rawStart, 5) + " 后开始";
                    timer.dateDisplay.badgeEnd = this.remainingTimeString(now, timer.rawEnd, 5) + " 后结束";
                } else if (timer.progress >= 100) {
                    timer.dateDisplay.barLabel = "已结束 " + this.remainingTimeString(now, timer.rawEnd, 5);
                    timer.dateDisplay.badgeEnd = "结束于 " + this.remainingTimeString(now, timer.rawEnd, 5) + " 前";
                    timer.dateDisplay.badgeStart = "开始于 " + this.remainingTimeString(now, timer.rawStart, 5) + " 前";
                } else {
                    timer.dateDisplay.barLabel = "剩余 " + this.remainingTimeString(now, timer.rawEnd, 2) + (timer.type == "weekend" ? "" : "（" + timer.progress.toFixed(1) + "%）");
                    timer.dateDisplay.badgeEnd = this.remainingTimeString(now, timer.rawEnd, 5) + " 后结束";
                    timer.dateDisplay.badgeStart = "已开始 " + this.remainingTimeString(now, timer.rawStart, 5);

                    // Increase priority if timer is active
                    if (timer.extraPriority) {
                        ev.bonusPriority += timer.extraPriority;
                    }
                }

                // Update markers
                if (timer.markersInfo.length > 0) {
                    var marks = timer.markersInfo, m, mark, next = Infinity, nextName, nextFound = false;
                    for (m = 0; m < marks.length; m++) {
                        mark = marks[m];
                        mark.tip = "<b>" + mark.label + "</b><br/>" + (timer.displayMode == "japan" ? mark.jptime : mark.localtime) + (now >= mark.rawtime ? "" : "<br/>（" + this.remainingTimeString(now, mark.rawtime, 5) + " 后开始）");
                        if (mark.rawtime > now && mark.rawtime < next) {
                            nextFound = true;
                            nextName = mark.label;
                            next = mark.rawtime;
                        }
                        if (now >= mark.rawtime) {
                            mark.started = true;
                            mark.color = "#2fc551";
                        }
                    }
                    if (nextFound && now >= timer.rawStart) {
                        timer.nextMarker = nextName + " 将在 " + this.remainingTimeString(now, next, 5) + " 后开始";
                    } else {
                        timer.nextMarker = "";
                    }
                } else {
                    timer.nextMarker = "";
                }
            }
            return timer.visible && timer.type != "weekend";
        },

        // HELPER FUNCTIONS
        prioritySort: function (a, b) {
            return (b.priority + b.bonusPriority) - (a.priority + a.bonusPriority);
        },
        toDurationObject: function (str) {
            if (typeof str !== "string") {
                return {};
            }
            var info = str.split(","),
                out = {},
                unitNames = ["seconds", "minutes", "hours", "days", "weeks", "months", "years"],
                part, val, unit;

            for (var i = 0; i < info.length; i++) {
                part = info[i].toLowerCase().trim().split(" ");
                val = parseInt(part[0], 10);
                unit = part[1];
                if (unit[unit.length - 1] != "s") {
                    unit = unit + "s";
                }
                if (unitNames.indexOf(unit) !== -1 && !isNaN(val)) {
                    out[unit] = val;
                }
            }
            return out;
        },
        countProgress: function (now, start, end) {
            var duration = end - start;
            var elapsed = now - start;

            if (elapsed <= 0) {
                return 0;
            } else if (elapsed >= duration) {
                return 100;
            } else {
                return elapsed / duration * 100;
            }
        },
        parseMoment: function (str) {
            var formats = [
                "MMMM D YYYY, H:mm",
                "MMM D YYYY, H:mm",
                "MMMM D YYYY",
                "MMM D YYYY"
            ];
            var parsed = moment.tz(str, formats, "en", true, "Asia/Tokyo");
            if (parsed.isValid()) {
                return parsed;
            }
            var match = /^(\d{1,2})月\s*(\d{1,2})日\s*(\d{4})(?:,\s*(\d{1,2}):(\d{2}))?$/.exec(String(str).trim());
            if (match) {
                return moment.tz({
                    year: Number(match[3]),
                    month: Number(match[1]) - 1,
                    day: Number(match[2]),
                    hour: Number(match[4] || 0),
                    minute: Number(match[5] || 0)
                }, "Asia/Tokyo");
            }
            return moment.invalid();
        },
        timeDescription: function (time, steps) {
            var sec = time / 1000;

            var s = [];
            var n;
            var d = [[24 * 60 * 60, "天"], [60 * 60, "小时"], [60, "分"], [1, "秒"]];
            for (var j = 0; j < 4; ++j) {
                n = parseInt(sec / d[j][0], 10);
                if (n > 0) {
                    s.push((n + "" + d[j][1] + (n > 1 ? "" : "")));
                    sec -= n * d[j][0];
                }
            }
            if (s.length === 0) {
                return "0秒";
            } else {
                return s.splice(0, steps).join("");
            }
        },
        remainingTimeString: function (now, target, steps) {
            var diff = target - now;

            if (diff >= 0) {

                return this.timeDescription(diff, steps || 2);
            } else {
                return this.timeDescription(-diff, steps || 2);
            }
        }
    },
    created: function () {
        this.loadQueryParams();
        this.buildTimerData(timerData);
        this.updateTimerData();
        this.updateClocks();
        this.changeTimezone();
        // 设置语言环境

        setInterval(this.updateClocks, 1 * 1000);

        // Load artworks from static JS (pure static site, no fetch needed)
        this.shutdownArtworks = (window.kirafanShutdownArtworks && window.kirafanShutdownArtworks.items) || [];
    }
});

(function () {
    function initOfficialHeroCarousel() {
        var root = document.getElementById("officialHeroCarousel");
        if (!root) {
            return;
        }

        var slides = Array.prototype.slice.call(root.querySelectorAll(".official-hero-slide"));
        var dots = Array.prototype.slice.call(root.querySelectorAll("[data-hero-slide]"));
        var activeIndex = 0;
        var changeRequest = 0;
        var autoplayTimer;
        var touchStartX = null;
        var autoplayDelay = 5200;
        var transitionTimer;
        var slideCleanupTimer;
        var motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
        var interactionPaused = false;

        if (slides.length < 2) {
            return;
        }

        function normalizedIndex(index) {
            return (index + slides.length) % slides.length;
        }

        function hydrateSlide(index) {
            var slide = slides[normalizedIndex(index)];
            var image = slide.querySelector("img");
            var sources = slide.querySelectorAll("source[data-srcset]");

            if (!image) {
                return Promise.resolve(false);
            }
            if (slide.dataset.loaded === "true" && image.complete && image.naturalWidth > 0) {
                return Promise.resolve(true);
            }

            Array.prototype.forEach.call(sources, function (source) {
                source.srcset = source.dataset.srcset;
                source.removeAttribute("data-srcset");
            });
            if (image.dataset.src) {
                image.src = image.dataset.src;
                image.removeAttribute("data-src");
            }

            return new Promise(function (resolve) {
                var settled = false;

                function finish(loaded) {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    image.removeEventListener("load", onLoad);
                    image.removeEventListener("error", onError);

                    if (!loaded) {
                        slide.dataset.loadFailed = "true";
                        resolve(false);
                        return;
                    }

                    var decoded = typeof image.decode === "function"
                        ? image.decode().catch(function () { return; })
                        : Promise.resolve();
                    decoded.then(function () {
                        slide.dataset.loaded = "true";
                        resolve(true);
                    });
                }

                function onLoad() {
                    finish(true);
                }

                function onError() {
                    finish(false);
                }

                image.addEventListener("load", onLoad, { once: true });
                image.addEventListener("error", onError, { once: true });
                if (image.complete) {
                    finish(image.naturalWidth > 0);
                }
            });
        }

        function updateControls() {
            dots.forEach(function (dot, index) {
                var isActive = index === activeIndex;
                dot.classList.toggle("is-active", isActive);
                if (isActive) {
                    dot.setAttribute("aria-current", "true");
                } else {
                    dot.removeAttribute("aria-current");
                }
            });
        }

        function canAutoplay() {
            return !document.hidden && !motionPreference.matches && !interactionPaused;
        }

        function resetAutoplay() {
            window.clearTimeout(autoplayTimer);
            var autoplayEnabled = canAutoplay();
            root.classList.toggle("is-autoplay-paused", !autoplayEnabled);
            if (!autoplayEnabled) {
                return;
            }
            var activeDot = dots[activeIndex];
            if (activeDot) {
                activeDot.classList.remove("is-active");
                void activeDot.offsetWidth;
                activeDot.classList.add("is-active");
            }
            autoplayTimer = window.setTimeout(function () {
                showSlide(activeIndex + 1);
            }, autoplayDelay);
        }

        function playHeroTransition() {
            window.clearTimeout(transitionTimer);
            root.classList.remove("is-transitioning");
            void root.offsetWidth;
            root.classList.add("is-transitioning");
            transitionTimer = window.setTimeout(function () {
                root.classList.remove("is-transitioning");
            }, 1100);
        }

        function showSlide(index) {
            var nextIndex = normalizedIndex(index);
            var request = ++changeRequest;

            if (nextIndex === activeIndex) {
                resetAutoplay();
                return;
            }

            root.setAttribute("aria-busy", "true");
            hydrateSlide(nextIndex).then(function (loaded) {
                if (request !== changeRequest) {
                    return;
                }
                root.removeAttribute("aria-busy");
                if (!loaded) {
                    resetAutoplay();
                    return;
                }

                window.clearTimeout(slideCleanupTimer);
                slides.forEach(function (slide) {
                    slide.classList.remove("is-leaving");
                });
                slides[activeIndex].classList.add("is-leaving");
                slides[activeIndex].classList.remove("is-active");
                slides[activeIndex].setAttribute("aria-hidden", "true");
                slides[nextIndex].classList.add("is-active");
                slides[nextIndex].setAttribute("aria-hidden", "false");
                activeIndex = nextIndex;
                updateControls();
                playHeroTransition();

                slideCleanupTimer = window.setTimeout(function () {
                    slides.forEach(function (slide) {
                        slide.classList.remove("is-leaving");
                    });
                }, 950);

                hydrateSlide(activeIndex + 1);
                resetAutoplay();
            });
        }

        root.addEventListener("click", function (event) {
            var slideControl = event.target.closest("[data-hero-slide]");
            if (slideControl && root.contains(slideControl)) {
                showSlide(Number(slideControl.dataset.heroSlide));
            }
        });

        root.addEventListener("touchstart", function (event) {
            touchStartX = event.touches.length === 1 ? event.touches[0].clientX : null;
        }, { passive: true });
        root.addEventListener("touchend", function (event) {
            if (touchStartX === null || event.changedTouches.length !== 1) {
                touchStartX = null;
                return;
            }
            var distance = event.changedTouches[0].clientX - touchStartX;
            touchStartX = null;
            if (Math.abs(distance) >= 44) {
                showSlide(activeIndex + (distance < 0 ? 1 : -1));
            }
        }, { passive: true });
        root.addEventListener("mouseenter", function () {
            interactionPaused = true;
            resetAutoplay();
        });
        root.addEventListener("mouseleave", function () {
            interactionPaused = false;
            resetAutoplay();
        });
        root.addEventListener("focusin", function () {
            interactionPaused = true;
            resetAutoplay();
        });
        root.addEventListener("focusout", function (event) {
            if (!root.contains(event.relatedTarget)) {
                interactionPaused = false;
                resetAutoplay();
            }
        });
        document.addEventListener("visibilitychange", resetAutoplay);
        if (motionPreference.addEventListener) {
            motionPreference.addEventListener("change", resetAutoplay);
        }

        hydrateSlide(0).then(function () {
            hydrateSlide(1);
            resetAutoplay();
        });
    }

    document.addEventListener("DOMContentLoaded", initOfficialHeroCarousel);
})();

(function () {
    function initScrollReveals() {
        var items = Array.prototype.slice.call(document.querySelectorAll(
            ".official-roster-copy, .official-hero-carousel, .section-heading, .memory-card, .comments-frame, .memorial-entry"
        ));

        if (!items.length) {
            return;
        }

        items.forEach(function (item, index) {
            item.classList.add("motion-reveal");
            item.style.setProperty("--motion-delay", ((index % 6) * 70) + "ms");
        });

        if (!("IntersectionObserver" in window)) {
            items.forEach(function (item) {
                item.classList.add("is-in-view");
            });
            return;
        }

        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) {
                    return;
                }
                entry.target.classList.add("is-in-view");
                observer.unobserve(entry.target);
            });
        }, {
            rootMargin: "0px 0px -8% 0px",
            threshold: 0.08
        });

        items.forEach(function (item) {
            observer.observe(item);
        });
    }

    document.addEventListener("DOMContentLoaded", function () {
        window.requestAnimationFrame(initScrollReveals);
    });
})();

(function () {
    var offerings = window.kirafanOriginalCharacters || [];
    var storageKey = "kirafan-offering-count";
    var closeTimer;
    var preparedOffering = null;
    var activeSmokeCleanup = null;

    function readOfferingCount() {
        try {
            return Number(window.localStorage.getItem(storageKey)) || 0;
        } catch (error) {
            return 0;
        }
    }

    function writeOfferingCount(count) {
        try {
            window.localStorage.setItem(storageKey, String(count));
        } catch (error) {
            return;
        }
    }

    function pickOfferingIndex() {
        return Math.floor(Math.random() * offerings.length);
    }

    // 只提前准备下一位角色，避免一次性加载全部立绘占用大量流量。
    function preloadOffering(offering) {
        var preloadedImage = new Image();
        preloadedImage.decoding = "async";
        if ("fetchPriority" in preloadedImage) {
            preloadedImage.fetchPriority = "high";
        }

        return new Promise(function (resolve) {
            var settled = false;

            function finish() {
                if (settled) {
                    return;
                }
                settled = true;

                if (typeof preloadedImage.decode === "function") {
                    preloadedImage.decode().catch(function () {
                        return;
                    }).then(function () {
                        resolve(preloadedImage);
                    });
                    return;
                }
                resolve(preloadedImage);
            }

            preloadedImage.addEventListener("load", finish, { once: true });
            preloadedImage.addEventListener("error", finish, { once: true });
            preloadedImage.src = offering.image;
            if (preloadedImage.complete) {
                finish();
            }
        });
    }

    function prepareNextOffering() {
        var offeringIndex = pickOfferingIndex();
        var offering = offerings[offeringIndex];
        preparedOffering = {
            character: offering,
            ready: preloadOffering(offering)
        };
    }

    // 点击后先完成点燃与烟雾扩散，再揭示预加载好的角色。
    function playOfferingEffect(shrine) {
        if (!shrine) {
            return;
        }

        shrine.classList.remove("is-offering");
        // 强制重排，保证连续点击时脉冲动画能重新播放
        void shrine.offsetWidth;
        shrine.classList.add("is-offering");
        window.setTimeout(function () {
            shrine.classList.remove("is-offering");
        }, 1400);

        var layer = shrine.querySelector(".spark-layer");
        if (!layer) {
            layer = document.createElement("div");
            layer.className = "spark-layer";
            layer.setAttribute("aria-hidden", "true");
            shrine.appendChild(layer);
        }

        var wave = document.createElement("span");
        wave.className = "offering-wave";
        layer.appendChild(wave);

        for (var i = 0; i < 20; i++) {
            var spark = document.createElement("span");
            var isPetal = i % 5 === 0;
            var isEmber = i % 4 === 1;
            spark.className = isPetal ? "spark spark-petal" : (isEmber ? "spark spark-ember" : "spark");
            spark.textContent = isPetal ? "◆" : (isEmber ? "•" : (i % 3 === 0 ? "✦" : "✧"));
            spark.style.left = (10 + Math.random() * 80) + "%";
            spark.style.bottom = (10 + Math.random() * 24) + "%";
            spark.style.fontSize = (7 + Math.random() * 9).toFixed(1) + "px";
            spark.style.animationDelay = (Math.random() * 260).toFixed(0) + "ms";
            spark.style.animationDuration = (1200 + Math.random() * 700).toFixed(0) + "ms";
            spark.style.setProperty("--spark-drift", (-48 + Math.random() * 96).toFixed(0) + "px");
            spark.style.setProperty("--spark-turn", (-220 + Math.random() * 440).toFixed(0) + "deg");
            layer.appendChild(spark);
        }

        if (activeSmokeCleanup) {
            activeSmokeCleanup();
        }

        var oldSmokeLayer = document.querySelector(".offering-smoke-burst");
        if (oldSmokeLayer) {
            oldSmokeLayer.remove();
        }

        var incense = shrine.querySelector(".incense-stick");
        if (incense) {
            var smokeLayer = document.createElement("div");
            var smokePositionFrame = 0;
            var smokePointerFrame = 0;
            var smokeSettleTimer = 0;
            var smokeRemovalTimer = 0;
            var smokeResizeObserver = null;
            var visualViewport = window.visualViewport;
            var pointerFlow = 0;
            var targetPointerFlow = 0;
            var smokeOriginX = null;
            var smokeOriginY = null;
            var lastPointerFlowTime = 0;
            var lastPointerX = null;
            var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            smokeLayer.className = "offering-smoke-burst";
            smokeLayer.setAttribute("aria-hidden", "true");

            function positionSmokeLayer() {
                window.cancelAnimationFrame(smokePositionFrame);
                smokePositionFrame = window.requestAnimationFrame(function () {
                    smokePositionFrame = 0;
                    if (!smokeLayer.isConnected || !incense.isConnected) {
                        return;
                    }

                    var incenseRect = incense.getBoundingClientRect();
                    var scrollLeft = window.pageXOffset || document.documentElement.scrollLeft || 0;
                    var scrollTop = window.pageYOffset || document.documentElement.scrollTop || 0;
                    smokeOriginX = incenseRect.left + incenseRect.width / 2;
                    smokeOriginY = incenseRect.top;
                    smokeLayer.style.left = (smokeOriginX + scrollLeft).toFixed(1) + "px";
                    smokeLayer.style.top = (incenseRect.top + scrollTop).toFixed(1) + "px";
                });
            }

            function handleSmokeLayoutChange() {
                positionSmokeLayer();
                window.clearTimeout(smokeSettleTimer);
                smokeSettleTimer = window.setTimeout(positionSmokeLayer, 120);
            }

            function renderPointerFlow(timestamp) {
                var frameScale = lastPointerFlowTime ? Math.min(2, (timestamp - lastPointerFlowTime) / 16.667) : 1;
                var followRate = 1 - Math.pow(0.86, frameScale);
                lastPointerFlowTime = timestamp;
                pointerFlow += (targetPointerFlow - pointerFlow) * followRate;
                targetPointerFlow *= Math.pow(0.94, frameScale);
                smokeLayer.style.setProperty("--smoke-flow-angle", (pointerFlow * 0.2).toFixed(2) + "deg");

                if (Math.abs(pointerFlow) < 0.05 && Math.abs(targetPointerFlow) < 0.05) {
                    smokePointerFrame = 0;
                    lastPointerFlowTime = 0;
                    return;
                }
                smokePointerFrame = window.requestAnimationFrame(renderPointerFlow);
            }

            function handlePointerMove(event) {
                if (smokeOriginX === null || smokeOriginY === null) {
                    return;
                }

                var smokeTop = smokeOriginY - 420;
                var nearestSmokeY = Math.max(smokeTop, Math.min(smokeOriginY, event.clientY));
                var distanceX = event.clientX - smokeOriginX;
                var distanceY = event.clientY - nearestSmokeY;
                var distance = Math.sqrt(distanceX * distanceX + distanceY * distanceY);
                var influence = Math.max(0, 1 - distance / 260);
                var pointerVelocityX = lastPointerX === null ? 0 : event.clientX - lastPointerX;
                lastPointerX = event.clientX;
                targetPointerFlow = Math.max(-16, Math.min(16, (-distanceX * 0.042 + pointerVelocityX * 0.3) * influence));

                if (!smokePointerFrame) {
                    smokePointerFrame = window.requestAnimationFrame(renderPointerFlow);
                }
            }

            function removeSmokeLayer() {
                window.clearTimeout(smokeRemovalTimer);
                window.clearTimeout(smokeSettleTimer);
                window.cancelAnimationFrame(smokePositionFrame);
                window.cancelAnimationFrame(smokePointerFrame);
                window.removeEventListener("resize", handleSmokeLayoutChange);
                window.removeEventListener("scroll", positionSmokeLayer);
                window.removeEventListener("pointermove", handlePointerMove);
                if (visualViewport) {
                    visualViewport.removeEventListener("resize", handleSmokeLayoutChange);
                }
                if (smokeResizeObserver) {
                    smokeResizeObserver.disconnect();
                }
                smokeLayer.remove();
                if (activeSmokeCleanup === removeSmokeLayer) {
                    activeSmokeCleanup = null;
                }
            }

            // 单一路径从香头出发，直接改变曲线形态，避免高开销的逐帧湍流滤镜。
            var svgNamespace = "http://www.w3.org/2000/svg";
            function createSvgElement(name, attributes) {
                var element = document.createElementNS(svgNamespace, name);
                Object.keys(attributes || {}).forEach(function (attribute) {
                    element.setAttribute(attribute, attributes[attribute]);
                });
                return element;
            }

            var smokeSvg = createSvgElement("svg", {
                "class": "offering-smoke-line",
                "viewBox": "-110 -430 220 430",
                "preserveAspectRatio": "xMidYMax meet"
            });
            var smokeDefs = createSvgElement("defs");
            var smokeGradient = createSvgElement("linearGradient", {
                "id": "offeringSmokeGradient",
                "gradientUnits": "userSpaceOnUse",
                "x1": "0",
                "y1": "0",
                "x2": "0",
                "y2": "-420"
            });
            [
                ["0%", "#59625e", "0.72"],
                ["18%", "#68716d", "0.6"],
                ["52%", "#858d89", "0.34"],
                ["82%", "#abb1ae", "0.16"],
                ["100%", "#c5c9c7", "0"]
            ].forEach(function (stopInfo) {
                smokeGradient.appendChild(createSvgElement("stop", {
                    "offset": stopInfo[0],
                    "stop-color": stopInfo[1],
                    "stop-opacity": stopInfo[2]
                }));
            });
            smokeDefs.appendChild(smokeGradient);
            smokeSvg.appendChild(smokeDefs);

            var smokeGroup = createSvgElement("g", {
                "class": "offering-smoke-line-group"
            });
            var smokeShapeA = "M 0 0 C -14 -30 42 -48 18 -82 C -12 -116 -58 -132 -28 -171 C 12 -207 64 -224 34 -262 C -2 -300 -62 -318 -22 -355 C 14 -385 50 -402 22 -420";
            var smokeShapeB = "M 0 0 C 14 -30 -38 -50 -14 -84 C 12 -118 56 -136 24 -173 C -14 -211 -64 -226 -28 -265 C 4 -303 62 -320 22 -357 C -14 -388 -48 -405 -16 -420";
            var smokeShapeC = "M 0 0 C -6 -32 28 -52 8 -85 C -18 -120 -44 -138 -14 -176 C 22 -213 48 -232 18 -269 C -16 -307 -46 -322 -4 -361 C 22 -391 34 -409 10 -420";
            var smokePath = createSvgElement("path", {
                "class": "offering-smoke-path",
                "d": smokeShapeA,
                "pathLength": "420"
            });
            smokePath.appendChild(createSvgElement("animate", {
                "attributeName": "d",
                "values": [smokeShapeA, smokeShapeB, smokeShapeC, smokeShapeA].join(";"),
                "keyTimes": "0;0.36;0.7;1",
                "keySplines": "0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1",
                "calcMode": "spline",
                "dur": reducedMotion ? "18s" : "9.6s",
                "repeatCount": "indefinite"
            }));
            smokeGroup.appendChild(smokePath);
            smokeSvg.appendChild(smokeGroup);
            smokeLayer.appendChild(smokeSvg);
            document.body.appendChild(smokeLayer);
            window.addEventListener("resize", handleSmokeLayoutChange);
            window.addEventListener("scroll", positionSmokeLayer, { passive: true });
            if (visualViewport) {
                visualViewport.addEventListener("resize", handleSmokeLayoutChange);
            }
            window.addEventListener("pointermove", handlePointerMove, { passive: true });
            if ("ResizeObserver" in window) {
                smokeResizeObserver = new ResizeObserver(handleSmokeLayoutChange);
                smokeResizeObserver.observe(shrine);
            }
            activeSmokeCleanup = removeSmokeLayer;
            positionSmokeLayer();
            smokeRemovalTimer = window.setTimeout(removeSmokeLayer, 3 * 60 * 1000);
        }

        window.setTimeout(function () {
            while (layer.firstChild) {
                layer.removeChild(layer.firstChild);
            }
        }, 2400);
    }

    function initOffering() {
        var button = document.getElementById("offeringButton");
        var shrine = document.getElementById("action-and-counter-holder");
        var modal = document.getElementById("offeringModal");
        var image = document.getElementById("offeringImage");
        var characterName = document.getElementById("offeringName");
        var characterJapanese = document.getElementById("offeringJapanese");
        var characterRomaji = document.getElementById("offeringRomaji");
        var characterChinese = document.getElementById("offeringChinese");
        var characterWiki = document.getElementById("offeringWiki");
        var characterGroup = document.getElementById("offeringGroup");
        var characterCv = document.getElementById("offeringCv");
        var characterArtist = document.getElementById("offeringArtist");
        var characterSeries = document.getElementById("offeringSeries");
        var message = document.getElementById("offeringMessage");
        var messageName = document.getElementById("offeringMessageName");
        var countLabel = document.getElementById("offeringCount");
        var count = readOfferingCount();

        if (!button || !modal || !image || !characterName || !characterJapanese || !characterRomaji || !characterChinese || !characterWiki || !characterGroup || !characterCv || !characterArtist || !characterSeries || !message || !messageName || !countLabel || offerings.length === 0) {
            return;
        }

        function renderCount() {
            countLabel.textContent = count > 0 ? "已上香 " + count + " 次" : "";
        }

        function closeOffering() {
            window.clearTimeout(closeTimer);
            modal.classList.remove("is-visible");
            window.setTimeout(function () {
                modal.hidden = true;
            }, 240);
        }

        button.addEventListener("click", function () {
            if (button.disabled) {
                return;
            }

            var currentOffering = preparedOffering;
            if (!currentOffering) {
                prepareNextOffering();
                currentOffering = preparedOffering;
            }
            preparedOffering = null;
            prepareNextOffering();

            var offering = currentOffering.character;
            button.disabled = true;
            button.setAttribute("aria-busy", "true");
            count += 1;
            writeOfferingCount(count);
            renderCount();
            playOfferingEffect(shrine);

            var ceremonyReady = new Promise(function (resolve) {
                window.setTimeout(resolve, 760);
            });

            Promise.all([currentOffering.ready, ceremonyReady]).then(function () {
                characterJapanese.textContent = offering.japanese;
                characterRomaji.textContent = offering.romaji;
                characterChinese.textContent = offering.chinese || "";
                characterChinese.hidden = !offering.chinese;
                characterWiki.href = offering.wikiUrl;
                characterGroup.textContent = offering.group + " · 原创角色";
                characterCv.textContent = offering.cv || "未公开";
                characterArtist.textContent = offering.artist || "未公开";
                characterSeries.textContent = offering.series || "きららファンタジア";
                messageName.textContent = offering.japanese;
                image.alt = offering.japanese + (offering.chinese ? " / " + offering.chinese : "");
                image.src = offering.image;

                var imageReady = typeof image.decode === "function"
                    ? image.decode().catch(function () { return; })
                    : Promise.resolve();

                return imageReady;
            }).then(function () {
                modal.classList.remove("is-revealing");
                void modal.offsetWidth;
                modal.hidden = false;
                window.requestAnimationFrame(function () {
                    modal.classList.add("is-visible");
                    modal.classList.add("is-revealing");
                });
                button.disabled = false;
                button.removeAttribute("aria-busy");
                closeTimer = window.setTimeout(closeOffering, 8000);
            });
        });

        modal.querySelectorAll("[data-close-offering]").forEach(function (element) {
            element.addEventListener("click", closeOffering);
        });
        modal.addEventListener("click", function (event) {
            closeOffering();
        });
        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && !modal.hidden) {
                closeOffering();
            }
        });
        renderCount();
        prepareNextOffering();
    }

    function markCounterUnavailable() {
        ["vercount_value_site_uv", "vercount_value_site_pv"].forEach(function (id) {
            var element = document.getElementById(id);
            if (element && element.textContent.trim() === "读取中") {
                element.textContent = "暂不可用";
                element.classList.add("is-unavailable");
            }
        });
    }

    window.handleVisitorCounterError = markCounterUnavailable;

    document.addEventListener("DOMContentLoaded", function () {
        initOffering();
        window.setTimeout(markCounterUnavailable, 6000);
        initGiscus();
        initBgmPlayer();
    });

    function initGiscus() {
        var config = window.kirafanGiscus;
        var target = document.getElementById("giscusThread");
        var setupNotice = document.getElementById("giscusSetupNotice");
        if (!config || !target || !setupNotice) {
            return;
        }
        if (!config.categoryId) {
            setupNotice.hidden = false;
            return;
        }

        var script = document.createElement("script");
        script.src = "https://giscus.app/client.js";
        script.async = true;
        script.crossOrigin = "anonymous";
        Object.keys(config).forEach(function (key) {
            if (key === "categoryId") {
                script.dataset.categoryId = config[key];
                return;
            }
            if (key === "theme") {
                script.dataset.theme = giscusTheme(config[key]);
                return;
            }
            script.dataset[key] = config[key];
        });
        target.appendChild(script);
    }

    // giscus renders in an iframe on its own origin, so a custom theme has to be
    // an absolute URL it can fetch cross-origin. Resolving it against this page
    // keeps host and scheme in step with wherever the site is actually served
    // from -- a hardcoded host is exactly what broke: github.io now 301s to the
    // custom domain over http, and an https iframe refuses that redirect as
    // mixed content, so the stylesheet never arrived and comments fell back to
    // giscus's own default.
    //
    // Over anything but https the custom sheet is unreachable for the same
    // reason, so ask for a built-in theme by name instead of a URL that is
    // guaranteed to fail. That is the case when serving the site locally.
    function giscusTheme(value) {
        var theme = String(value || "");
        if (!theme || !/\.css(\?|$)/.test(theme)) {
            return theme || "light";
        }
        var absolute = new URL(theme, window.location.href);
        if (absolute.protocol !== "https:") {
            return "light";
        }
        return absolute.href;
    }

    var bgmTracks = [
        { src: "audio/bgm/bgm_Prologue_0.mp3", title: "旅の始まり", note: "标题 / 登录画面", group: "title" },
        { src: "audio/bgm/bgm_town_1_0.mp3", title: "里の刻は今日も流れて", note: "村庄 · 早晨", group: "town" },
        { src: "audio/bgm/bgm_town_2_0.mp3", title: "変わらない一日", note: "村庄 · 白天", group: "town" },
        { src: "audio/bgm/bgm_town_3_0.mp3", title: "灯りを囲んで", note: "村庄 · 夜晚", group: "town" },
        { src: "audio/bgm/bgm_town_4_0.mp3", title: "トロピカルデイズ", note: "村庄 · 夏日", group: "town" },
        { src: "audio/bgm/bgm_town_5_0.mp3", title: "お菓子の用意を忘れずに", note: "村庄 · 万圣节", group: "town" },
        { src: "audio/bgm/bgm_town_shougatu_0.mp3", title: "一富士二鷹三茄子", note: "村庄 · 正月", group: "town" },
        { src: "audio/bgm/bgm_town_xmas_0.mp3", title: "街は一面雪景色", note: "村庄 · 圣诞节", group: "town" },
        { src: "audio/bgm/bgm_questselect_0.mp3", title: "はるかなる旅路", note: "任务选择", group: "quest" },
        { src: "audio/bgm/bgm_questselect_2_0.mp3", title: "神殿", note: "任务 · 神殿(推测)", group: "quest" },
        { src: "audio/bgm/bgm_questselect_3_0.mp3", title: "クエストBGM·3", note: "任务场景(未确认曲名)", group: "quest" },
        { src: "audio/bgm/bgm_gacha_0.mp3", title: "召喚の館", note: "召唤之馆 · 大厅(gacha.js)", group: "gacha" },
        { src: "audio/bgm/bgm_gachaplay_0.mp3", title: "出会いの予感", note: "召唤卡面演出(gacha.js)", group: "gacha" },
        { src: "audio/bgm/bgm_battle_1_0.mp3", title: "バトル -いつものように-", note: "普通战斗", group: "battle" },
        { src: "audio/bgm/bgm_battle_2_0.mp3", title: "バトルBGM·2", note: "战斗(未确认曲名)", group: "battle" },
        { src: "audio/bgm/bgm_battle_3_0.mp3", title: "バトルBGM·3", note: "战斗(未确认曲名)", group: "battle" },
        { src: "audio/bgm/bgm_battle_4_0.mp3", title: "バトルBGM·4", note: "战斗(未确认曲名)", group: "battle" },
        { src: "audio/bgm/bgm_battle_5_0.mp3", title: "バトル -筆頭神官アルシーヴ-", note: "战斗 · 阿尔西夫", group: "battle" },
        { src: "audio/bgm/bgm_battle_6_0.mp3", title: "バトル -けいおん!-", note: "战斗 · 轻音部", group: "battle" },
        { src: "audio/bgm/bgm_battle_7_0.mp3", title: "バトル -サマーバケーション-", note: "战斗 · 夏日", group: "battle" },
        { src: "audio/bgm/bgm_battle_8_0.mp3", title: "バトル -ゴーストパーティ-", note: "战斗 · 万圣节", group: "battle" },
        { src: "audio/bgm/bgm_battle_9_0.mp3", title: "バトルBGM·9", note: "战斗(未确认曲名)", group: "battle" },
        { src: "audio/bgm/bgm_battle_10_0.mp3", title: "バトルBGM·10", note: "战斗(未确认曲名)", group: "battle" },
        { src: "audio/bgm/bgm_battle_11_0.mp3", title: "バトルBGM·11", note: "战斗(未确认曲名)", group: "battle" },
        { src: "audio/bgm/bgm_battle_12_0.mp3", title: "バトルBGM·12", note: "战斗(未确认曲名)", group: "battle" },
        { src: "audio/bgm/bgm_battle_13_0.mp3", title: "バトルBGM·13", note: "战斗(未确认曲名)", group: "battle" },
        { src: "audio/bgm/bgm_battle_shougatu_0.mp3", title: "バトル -振袖を揺らして-", note: "战斗 · 正月", group: "battle" },
        { src: "audio/bgm/bgm_battle_win_0.mp3", title: "バトル -勝利-", note: "战斗胜利", group: "battle" },
        { src: "audio/bgm/bgm_battle_xmas_0.mp3", title: "バトル -ホワイトクリスマス-", note: "战斗 · 圣诞节", group: "battle" },
        { src: "audio/bgm/bgm_adv_1_0.mp3", title: "ADV BGM·1", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_2_0.mp3", title: "ADV BGM·2", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_3_0.mp3", title: "ADV BGM·3", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_4_0.mp3", title: "ADV BGM·4", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_5_0.mp3", title: "ADV BGM·5", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_6_0.mp3", title: "ADV BGM·6", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_7_0.mp3", title: "張り詰めた空気", note: "剧情 · 紧张(推测)", group: "adv" },
        { src: "audio/bgm/bgm_adv_8_0.mp3", title: "ADV BGM·8", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_9_0.mp3", title: "ADV BGM·9", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_10_0.mp3", title: "緊急事態!", note: "剧情 · 紧急(推测)", group: "adv" },
        { src: "audio/bgm/bgm_adv_11_0.mp3", title: "ADV BGM·11", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_12_0.mp3", title: "ここは任せて!", note: "剧情 · 可靠(确认)", group: "adv" },
        { src: "audio/bgm/bgm_adv_13_0.mp3", title: "ADV BGM·13", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_14_0.mp3", title: "ADV BGM·14", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_15_0.mp3", title: "ADV BGM·15", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_16_0.mp3", title: "ADV BGM·16", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_17_0.mp3", title: "ADV BGM·17", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_18_0.mp3", title: "ADV BGM·18", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_19_0.mp3", title: "ADV BGM·19", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_20_0.mp3", title: "ADV BGM·20", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_21_0.mp3", title: "ADV BGM·21", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_22_0.mp3", title: "ADV BGM·22", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_23_0.mp3", title: "ADV BGM·23", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_25_0.mp3", title: "ADV BGM·25", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_26_0.mp3", title: "ADV BGM·26", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_27_0.mp3", title: "七賢者のテーマ", note: "剧情 · 七贤者(推测)", group: "adv" },
        { src: "audio/bgm/bgm_adv_28_0.mp3", title: "ADV BGM·28", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_29_0.mp3", title: "ADV BGM·29", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_30_0.mp3", title: "ADV BGM·30", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_31_0.mp3", title: "ADV BGM·31", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_32_0.mp3", title: "ADV BGM·32", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_33_0.mp3", title: "ADV BGM·33", note: "剧情(未确认曲名)", group: "adv" },
        { src: "audio/bgm/bgm_adv_shougatu_0.mp3", title: "謹賀新年エトワリア!", note: "剧情 · 正月(推测)", group: "adv" },
        { src: "audio/bgm/bgm_adv_xmas_0.mp3", title: "ADV BGM·xmas", note: "剧情 · 圣诞节(未确认)", group: "adv" },
        { src: "audio/bgm/bgm_4_common_0.mp3", title: "これがわたしのとっておき", note: "必杀技 · 星4共通", group: "unique" },
        { src: "audio/bgm/bgm_5_alchemist_0.mp3", title: "これがわたしのとっておき -アルケミスト-", note: "必杀技 · 炼金术师", group: "unique" },
        { src: "audio/bgm/bgm_5_fighter_0.mp3", title: "これがわたしのとっておき -せんし-", note: "必杀技 · 战士", group: "unique" },
        { src: "audio/bgm/bgm_5_knight_0.mp3", title: "これがわたしのとっておき -ナイト-", note: "必杀技 · 骑士", group: "unique" },
        { src: "audio/bgm/bgm_5_magician_0.mp3", title: "これがわたしのとっておき -まほうつかい-", note: "必杀技 · 魔法使", group: "unique" },
        { src: "audio/bgm/bgm_5_priest_0.mp3", title: "これがわたしのとっておき -そうりょ-", note: "必杀技 · 僧侣", group: "unique" }
    ];

    function initBgmPlayer() {
        var player = document.getElementById("bgmPlayer");
        var toggle = document.getElementById("bgmToggle");
        var menuToggle = document.getElementById("bgmMenuToggle");
        var menu = document.getElementById("bgmMenu");
        var list = document.getElementById("bgmMenuList");
        var nowLabel = document.getElementById("bgmNow");
        if (!player || !toggle || !menuToggle || !menu || !list || !nowLabel) {
            return;
        }

        var audio = new Audio();
        audio.loop = true;
        audio.volume = 0.4;
        audio.preload = "none";

        var enabled = readBgmPreference("kirafan-bgm-enabled", true);
        var currentIndex = readBgmPreference("kirafan-bgm-track-v2", 0);
        if (currentIndex < 0 || currentIndex >= bgmTracks.length) {
            currentIndex = 0;
        }
        var loadedIndex = -1;

        var bgmGroups = [
            { key: "all", label: "全部" },
            { key: "title", label: "标题" },
            { key: "town", label: "村庄" },
            { key: "quest", label: "任务" },
            { key: "gacha", label: "召唤" },
            { key: "battle", label: "战斗" },
            { key: "adv", label: "剧情" },
            { key: "unique", label: "必杀" }
        ];
        var groupLabels = {
            title: "タイトル / 标题",
            town: "里 / 村庄",
            quest: "クエスト / 任务",
            gacha: "召喚 / 召唤",
            battle: "バトル / 战斗",
            adv: "ADV / 剧情",
            unique: "とっておき / 必杀技"
        };
        var activeGroup = "all";

        buildBgmMenu();

        if (enabled) {
            loadTrack();
            var request = audio.play();
            if (request && typeof request.catch === "function") {
                request.catch(function () { /* waits for the first user gesture */ });
            }
            document.addEventListener("pointerdown", unlockBgm);
            document.addEventListener("keydown", unlockBgm);
        }
        syncBgmPlayer();

        function readBgmPreference(key, fallback) {
            try {
                var raw = window.localStorage.getItem(key);
                if (raw === null) {
                    return fallback;
                }
                if (typeof fallback === "boolean") {
                    return raw === "on";
                }
                var parsed = parseInt(raw, 10);
                return isNaN(parsed) ? fallback : parsed;
            } catch (error) {
                return fallback;
            }
        }

        function writeBgmPreference(key, value) {
            try {
                window.localStorage.setItem(key, value);
            } catch (error) { /* storage unavailable */ }
        }

        function buildTabs() {
            var tabs = document.getElementById("bgmTabs");
            if (!tabs) {
                return;
            }
            tabs.innerHTML = "";
            bgmGroups.forEach(function (g) {
                var btn = document.createElement("button");
                btn.type = "button";
                btn.className = "bgm-tab";
                btn.textContent = g.label;
                btn.setAttribute("role", "tab");
                btn.addEventListener("click", function () {
                    activeGroup = g.key;
                    updateTabs();
                    renderList();
                });
                tabs.appendChild(btn);
            });
            updateTabs();
        }

        function updateTabs() {
            var tabs = document.getElementById("bgmTabs");
            if (!tabs) {
                return;
            }
            var btns = tabs.querySelectorAll(".bgm-tab");
            bgmGroups.forEach(function (g, i) {
                var btn = btns[i];
                if (!btn) {
                    return;
                }
                var on = g.key === activeGroup;
                btn.classList.toggle("is-active", on);
                btn.setAttribute("aria-selected", on ? "true" : "false");
            });
        }

        function renderList() {
            list.innerHTML = "";
            var pendingGroup = null;
            bgmTracks.forEach(function (track, index) {
                if (activeGroup !== "all" && track.group !== activeGroup) {
                    return;
                }
                if (activeGroup === "all" && track.group !== pendingGroup) {
                    pendingGroup = track.group;
                    var header = document.createElement("div");
                    header.className = "bgm-group-label";
                    header.textContent = groupLabels[track.group] || track.group;
                    list.appendChild(header);
                }
                var item = document.createElement("button");
                item.type = "button";
                item.className = "bgm-track" + (index === currentIndex ? " is-active" : "");
                item.setAttribute("role", "option");
                item.setAttribute("data-track-index", String(index));
                item.setAttribute("aria-selected", index === currentIndex ? "true" : "false");
                var title = document.createElement("span");
                title.textContent = track.title;
                var note = document.createElement("small");
                note.textContent = track.note;
                item.appendChild(title);
                item.appendChild(note);
                item.addEventListener("click", function () {
                    selectBgmTrack(index);
                });
                list.appendChild(item);
            });
        }

        function buildBgmMenu() {
            buildTabs();
            renderList();
        }

        function loadTrack() {
            if (loadedIndex !== currentIndex) {
                loadedIndex = currentIndex;
                audio.src = bgmTracks[currentIndex].src;
            }
        }

        function playBgm() {
            loadTrack();
            var request = audio.play();
            if (request && typeof request.catch === "function") {
                request.catch(function () { /* gesture required */ });
            }
        }

        function selectBgmTrack(index) {
            currentIndex = index;
            writeBgmPreference("kirafan-bgm-track-v2", String(index));
            enabled = true;
            writeBgmPreference("kirafan-bgm-enabled", "on");
            playBgm();
            syncBgmPlayer();
        }

        function unlockBgm() {
            document.removeEventListener("pointerdown", unlockBgm);
            document.removeEventListener("keydown", unlockBgm);
            if (enabled) {
                playBgm();
                syncBgmPlayer();
            }
        }

        function setBgmMenuOpen(open) {
            menu.hidden = !open;
            menuToggle.setAttribute("aria-expanded", open ? "true" : "false");
            if (open) {
                renderList();
            }
        }

        function syncBgmPlayer() {
            var playing = enabled && !audio.paused;
            player.classList.toggle("is-playing", playing);
            player.classList.toggle("is-muted", !enabled);
            toggle.setAttribute("aria-pressed", playing ? "true" : "false");
            toggle.setAttribute("aria-label", playing ? "暂停BGM" : "播放BGM");
            nowLabel.textContent = bgmTracks[currentIndex].title;
            Array.prototype.forEach.call(list.querySelectorAll(".bgm-track"), function (item) {
                var trackIndex = parseInt(item.getAttribute("data-track-index"), 10);
                var on = trackIndex === currentIndex;
                item.classList.toggle("is-active", on);
                item.setAttribute("aria-selected", on ? "true" : "false");
            });
        }

        toggle.addEventListener("click", function () {
            if (enabled && audio.paused) {
                playBgm();
            } else {
                enabled = !enabled;
                writeBgmPreference("kirafan-bgm-enabled", enabled ? "on" : "off");
                if (enabled) {
                    playBgm();
                } else {
                    audio.pause();
                }
            }
            syncBgmPlayer();
        });

        menuToggle.addEventListener("click", function () {
            setBgmMenuOpen(menu.hidden);
        });

        document.addEventListener("click", function (event) {
            if (!menu.hidden && !player.contains(event.target)) {
                setBgmMenuOpen(false);
            }
        });

        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && !menu.hidden) {
                setBgmMenuOpen(false);
            }
        });

        audio.addEventListener("play", syncBgmPlayer);
        audio.addEventListener("pause", syncBgmPlayer);
    }
})();
