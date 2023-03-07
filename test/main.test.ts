import test from "ava";

const sum = (a: number, b: number) => a + b;

test("sum", (t) => {
  t.is(sum(0, 0), 0);
  t.is(sum(2, 2), 4);
});
