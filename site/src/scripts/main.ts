// コードのコピー
for (const btn of document.querySelectorAll<HTMLButtonElement>(".copy")) {
  btn.addEventListener("click", async () => {
    const code = btn.parentElement?.querySelector("code")?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(code);
      btn.textContent = "コピーしました";
    } catch {
      btn.textContent = "コピーできません";
    }
    setTimeout(() => (btn.textContent = "コピー"), 1600);
  });
}

// ヒーローのデモ: ターミナルの行数と電話の画面を順に進める
const stage = document.getElementById("stage");
if (stage) {
  const lines = [...stage.querySelectorAll<HTMLElement>(".tl")];
  const show = (n: number, phone: string) => {
    for (const l of lines) l.classList.toggle("on", Number(l.dataset.line) <= n);
    stage.dataset.phone = phone;
    stage.dataset.step = String(n);
  };
  // [表示する行数, 電話の状態, 次までのミリ秒]
  const seq: [number, string, number][] = [
    [1, "idle", 2600],
    [2, "idle", 1800],
    [3, "idle", 2000],
    [5, "idle", 1500],
    [6, "ring", 3400],
    [6, "ask", 3800],
    [6, "answer", 2800],
    [7, "thanks", 2600],
    [8, "idle", 3600],
  ];

  // 表示確認用: ?demo=ring のように状態を固定できる (idle / ring / ask / answer / thanks)
  const pinned = new URLSearchParams(location.search).get("demo");
  const pinnedStep = seq.find(([, phone]) => phone === pinned);
  if (pinnedStep) {
    show(pinnedStep[0], pinnedStep[1]);
  } else if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    show(8, "answer");
  } else {
    let i = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const [n, phone, ms] = seq[i]!;
      show(n, phone);
      i = (i + 1) % seq.length;
      timer = setTimeout(tick, ms);
    };
    // 画面外では止める
    new IntersectionObserver(([entry]) => {
      clearTimeout(timer);
      if (entry?.isIntersecting) tick();
    }).observe(stage);
  }
}

// 場面のアニメーション: 1〜4を順に進める。説明を押すとその場面へ移る
const story = document.getElementById("story");
if (story) {
  const buttons = [...story.querySelectorAll<HTMLButtonElement>("[data-go]")];
  const ms = [0, 3600, 6200, 6000, 5000];
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // 表示確認用: ?scene=1 のように場面を固定できる
  const fixed = Number(new URLSearchParams(location.search).get("scene"));
  const auto = !still && !(fixed >= 1 && fixed <= 4);
  let step = fixed >= 1 && fixed <= 4 ? fixed : Number(story.dataset.step);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let visible = false;
  const go = (n: number) => {
    step = n;
    story.dataset.step = String(n);
    for (const b of buttons) {
      if (Number(b.dataset.go) === n) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
    }
    clearTimeout(timer);
    if (auto && visible) timer = setTimeout(() => go((n % 4) + 1), ms[n]);
  };
  for (const b of buttons) b.addEventListener("click", () => go(Number(b.dataset.go)));
  go(step);
  if (auto) {
    // 見えたら最初から始め、画面外では止める
    new IntersectionObserver(
      ([entry]) => {
        visible = Boolean(entry?.isIntersecting);
        if (visible) go(1);
        else clearTimeout(timer);
      },
      { threshold: 0.35 },
    ).observe(story);
  }
}
