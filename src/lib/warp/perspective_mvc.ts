export { weights } from "./mvc";

function normalize(pts: Float64Array): Float64Array {
    var n = pts.length / 2;
    var cx = 0;
    var cy = 0;
    for (var k = 0; k < n; k++) {
        cx += pts[2 * k];
        cy += pts[2 * k + 1];
    }
    cx = cx * (1 / n);
    cy = cy * (1 / n);

    var d = 0;
    for (var k = 0; k < n; k++) {
        d += Math.sqrt((pts[2 * k] - cx) ** 2 + (pts[2 * k + 1] - cy) ** 2);
    }
    d = d / n;

    var s = d > 0 ? Math.SQRT2 / d : 1;
    var out = new Float64Array(pts.length);
    for (var k = 0; k < n; k++) {
        out[2 * k] = (pts[2 * k] - cx) * s;
        out[2 * k + 1] = (pts[2 * k + 1] - cy) * s;
    }
    return out;
}

function solve(A: number[][], b: number[]): number[] | null {
    var n = b.length;
    var M = A.map((row, r) => [...row, b[r]]);
    for (var c = 0; c < n; c++) {
        var p = c;
        for (var r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        if (Math.abs(M[p][c]) < 1e-12) return null;
        [M[c], M[p]] = [M[p], M[c]];
        for (var r = c + 1; r < n; r++) {
            var f = M[r][c] / M[c][c];
            for (var k = c; k <= n; k++) M[r][k] -= f * M[c][k];
        }
    }

    var x: number[] = new Array(n);
    for (var r = n - 1; r >= 0; r--) {
        var acc = M[r][n];
        for (var k = r + 1; k < n; k++) acc -= M[r][k] * x[k];
        x[r] = acc / M[r][r];
    }
    return x;
}

function homography(src: Float64Array, dst: Float64Array): number[] | null {
    var MtM = Array.from({ length: 8 }, () => new Array(8).fill(0));
    var Mtb = new Array(8).fill(0);
    var add = (row: number[], rhs: number) => {
        for (var r = 0; r < 8; r++) {
            Mtb[r] += row[r] * rhs;
            for (var c = 0; c < 8; c++) MtM[r][c] += row[r] * row[c];
        }
    };

    for (var k = 0; k < src.length / 2; k++) {
        var x = src[2 * k], y = src[2 * k + 1], u = dst[2 * k], v = dst[2 * k + 1];
        add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
        add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
    }
    return solve(MtM, Mtb);
}

function depths(rest: Float64Array, moved: Float64Array): Float64Array {
    var n = rest.length / 2;
    var flat = new Float64Array(n).fill(1);
    if (n < 4) return flat;

    var src = normalize(rest);
    var H = homography(src, normalize(moved));
    if (!H) return flat;

    var z = new Float64Array(n);
    for (var k = 0; k < n; k++) {
        z[k] = H[6] * src[2 * k] + H[7] * src[2 * k + 1] + 1;
        if (!Number.isFinite(z[k]) || z[k] <= 1e-9) return flat;
    }
    return z;
}

export function deformer(rest: Float64Array, moved: Float64Array, log: (log: any) => void = (a) => {}) {
    var n = moved.length / 2;
    var z = depths(rest, moved);

    log({ z: Array.from(z) });

    return (w: Float64Array, out: Float64Array) => {
        var x = 0;
        var y = 0;
        var W = 0;
        for (var i = 0; i < n; i++) {
            var wz = w[i] * z[i];
            x += wz * moved[2 * i];
            y += wz * moved[2 * i + 1];
            W += wz;
        }
        out[0] = x / W;
        out[1] = y / W;
    };
}
