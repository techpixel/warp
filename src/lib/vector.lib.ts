export class Vector2D {
    i: number;
    j: number;

    constructor(i: number = 0, j: number = 0) {
        this.i = i;
        this.j = j;
    }

    add(vec: Vector2D) {
        return new Vector2D(this.i + vec.i, this.j + vec.j);
    }

    sub(vec: Vector2D) {
        return new Vector2D(this.i - vec.i, this.j - vec.j);
    }

    scale(a: number) {
        return new Vector2D(this.i * a, this.j * a);
    }

    norm() {
        return Math.sqrt(Math.pow(this.i, 2) + Math.pow(this.j, 2));
    }

    det(vec: Vector2D) {
        return this.i * vec.j - this.j * vec.i;
    }

    dot(vec: Vector2D) {
        return this.i * vec.i + this.j * vec.j;
    }

    dist(vec: Vector2D) {
        return Math.sqrt(Math.pow(this.i - vec.i, 2) + Math.pow(this.j - vec.j, 2));
    }
}