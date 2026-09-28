// The renderer and simulation share geometry, not estimated display radii.
export const ATTACK_BACK_REACH = .2;
export const BURST_ROW_REACH = 1;

export function attackContains(unit, target, rule) {
    const distance = target.x - unit.col;
    const rowReach = rule.kind === "shooter" && rule.multi ? rule.multi.rows : 0;
    return Math.abs(target.row - unit.row) <= rowReach && distance >= -ATTACK_BACK_REACH && distance <= rule.range;
}

export function healingContains(unit, target, rule) {
    return target.row === unit.row && Math.abs(target.col - unit.col) <= rule.range;
}

// The 3×3 square around a support, the unit's own cell included.
export function areaContains(unit, target) {
    return Math.abs(target.row - unit.row) <= 1 && Math.abs(target.col - unit.col) <= 1;
}

export function burstContains(origin, target, rule) {
    return Math.abs(target.row - origin.row) <= BURST_ROW_REACH && Math.abs(target.x - origin.col) <= rule.radius;
}

function laneCells(row, col, range, board) {
    const cells = [];
    for (let c = 0; c < board.cols; c++) {
        const left = Math.max(c - .5, col - ATTACK_BACK_REACH);
        const right = Math.min(c + .5, col + range);
        if (right - left > 1e-8) { cells.push({ row, col: c, left, right }); }
    }
    return cells;
}

function squareCells(row, col, board) {
    const cells = [];
    for (let r = Math.max(0, row - 1); r <= Math.min(board.rows - 1, row + 1); r++) {
        for (let c = Math.max(0, col - 1); c <= Math.min(board.cols - 1, col + 1); c++) { cells.push({ row: r, col: c, left: c - .5, right: c + .5 }); }
    }
    return cells;
}

export function placementCoverage(rule, row, col, board) {
    if (!rule || !Number.isInteger(row) || !Number.isInteger(col)
        || row < 0 || row >= board.rows || col < 0 || col >= board.cols) { return null; }
    let cells = [];
    const origin = { row, col };
    let kind = "placement";
    let text = "仅占用此格，没有周围作用范围";
    if (rule.kind === "healer" && rule.area) {
        kind = "healing"; text = "周围3×3范围内的受伤同伴都会得到治疗";
        cells = squareCells(row, col, board);
    } else if (rule.kind === "healer") {
        kind = "healing";
        text = `同一路，距离${rule.range}格内可治疗，包含自身`;
        for (let c = 0; c < board.cols; c++) {
            if (healingContains(origin, { row, col: c }, rule)) { cells.push({ row, col: c, left: c - .5, right: c + .5 }); }
        }
    } else if (rule.kind === "shielder") {
        kind = "healing"; text = "为周围3×3范围内的同伴附加护盾";
        cells = squareCells(row, col, board);
    } else if (rule.kind === "beacon") {
        kind = "support"; text = "周围3×3范围内的同伴出手更快";
        cells = squareCells(row, col, board);
    } else if (rule.kind === "gear") {
        kind = "gear";
        text = `为落点同格的同伴装上：${rule.gear.label}。一名同伴只能携带一件装备`;
        cells = [{ row, col, left: col - .5, right: col + .5 }];
    } else if (rule.kind === "burst") {
        kind = "burst";
        text = `${rule.windup}秒后生效，覆盖相邻三路、落点前后${rule.radius}格`;
        const firstRow = Math.max(0, row - BURST_ROW_REACH);
        const lastRow = Math.min(board.rows - 1, row + BURST_ROW_REACH);
        for (let r = firstRow; r <= lastRow; r++) {
            for (let c = 0; c < board.cols; c++) {
                const left = Math.max(c - .5, col - rule.radius);
                const right = Math.min(c + .5, col + rule.radius);
                if (right - left > 1e-8) { cells.push({ row: r, col: c, left, right }); }
            }
        }
    } else if (Number.isFinite(rule.range)) {
        kind = "attack";
        const reach = rule.kind === "shooter" ? `射程${rule.range}格` : rule.kind === "lobber" ? `越过前排抛投，射程${rule.range}格` : `近身攻击距离${rule.range}格`;
        const lead = rule.kind === "shooter" && rule.multi ? "本路及相邻两路均可向右攻击" : "同路向右";
        text = `${lead}，${reach}${rule.guardReduction ? "；增防仅作用于自身" : ""}${rule.splash || rule.onHit?.splash ? "；落点波及相邻两路" : ""}`;
        if (rule.kind === "shooter" && rule.multi) {
            for (let r = Math.max(0, row - rule.multi.rows); r <= Math.min(board.rows - 1, row + rule.multi.rows); r++) {
                for (const cell of laneCells(r, col, rule.range, board)) { cells.push(cell); }
            }
        } else {
            cells = laneCells(row, col, rule.range, board);
        }
    }
    return { kind, origin, cells, text };
}
