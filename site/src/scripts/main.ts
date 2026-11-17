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
    [1, "idle", 2200],
    [2, "idle", 2000],
    [4, "idle", 1500],
    [5, "ring", 3400],
    [5, "ask", 3800],
    [5, "answer", 2800],
    [6, "thanks", 2600],
    [7, "idle", 3600],
  ];

  // 表示確認用: ?demo=ring のように状態を固定できる (idle / ring / ask / answer / thanks)
  const pinned = new URLSearchParams(location.search).get("demo");
  const pinnedStep = seq.find(([, phone]) => phone === pinned);
  if (pinnedStep) {
    show(pinnedStep[0], pinnedStep[1]);
  } else if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    show(7, "answer");
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
