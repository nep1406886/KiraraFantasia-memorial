// The renderer and simulation share geometry, not estimated display radii.
export const ATTACK_BACK_REACH = .2;
export const BURST_ROW_REACH = 1;

export function attackContains(unit, target, rule) {
    const distance = target.x - unit.col;
    return target.row === unit.row && distance >= -ATTACK_BACK_REACH && distance <= rule.range;
}

export function healingContains(unit, target, rule) {
    return target.row === unit.row && Math.abs(target.col - unit.col) <= rule.range;
}

export function burstContains(origin, target, rule) {
    return Math.abs(target.row - origin.row) <= BURST_ROW_REACH && Math.abs(target.x - origin.col) <= rule.radius;
}

export function placementCoverage(rule, row, col, board) {
    if (!rule || !Number.isInteger(row) || !Number.isInteger(col)
        || row < 0 || row >= board.rows || col < 0 || col >= board.cols) { return null; }
    const cells = [];
    const origin = { row, col };
    let kind = "placement";
    let text = "仅占用此格，没有周围作用范围";
    if (rule.kind === "healer") {
        kind = "healing";
        text = `同一路，距离${rule.range}格内可治疗，包含自身`;
        for (let c = 0; c < board.cols; c++) {
            if (healingContains(origin, { row, col: c }, rule)) { cells.push({ row, col: c, left: c - .5, right: c + .5 }); }
        }
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
        text = `同路向右，射程${rule.range}格${rule.kind === "guard" ? "；增防仅作用于自身" : ""}`;
        for (let c = 0; c < board.cols; c++) {
            const left = Math.max(c - .5, col - ATTACK_BACK_REACH);
            const right = Math.min(c + .5, col + rule.range);
            if (right - left > 1e-8) { cells.push({ row, col: c, left, right }); }
        }
    }
    return { kind, origin, cells, text };
}
