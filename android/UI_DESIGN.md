# Android UI

Compose Material 3の標準コンポーネントと色の役割を使います。iOSの画面構造をそのまま持ち込まず、項目の内容と操作を読み取れる構成にします。

- 設定は見出しと`ListItem`でまとめ、アイコン・項目名・現在の状態を表示します。一律の右向き矢印や行ごとの丸い装飾は付けません。権限の行全体から端末の設定を開き、接続変更・解除は文字付きのボタンにします。
- 未回答の質問は1件を1枚のクリック可能な`Card`にまとめます。質問を大きく、送信元・時刻・回答方法を補助情報として示し、「回答する」「回答を続ける」「通話を開く」で操作を伝えます。
- 対応状態は標準の単一選択`SegmentedButton`を使い、チェックと配色で選択状態を示します。文字が大きい場合は縦並びのラジオボタンに切り替えます。
- アプリ名をホームの大きなトップバーに表示し、設定・質問は通常のトップバーを使います。通話画面はトップバーを置かず、終了後も説明と操作だけを表示します。戻る操作はAndroidの戻るボタンと、トップバーがある画面ではその戻るボタンで扱います。
- 背景・カード・文字・ボタンは`surfaceContainerLow`などのMaterialの役割から色を選びます。Android 12以降はダイナミックカラー、ほかはライト／ダークの配色を使います。
- 回答フォームは選択肢を押すと送信することを明示します。送信成功時だけ短い完了表示を経て一覧へ戻り、失敗時は入力を保持します。
- 通話の用件は質問本文の上に表示します。会話記録と同じ返信を別カードで重複表示しません。
- 標準のタップ領域・リップル・読み上げの役割を保ち、設定の見出しと操作のラベルを付けます。破壊的な操作は確認ダイアログを経由します。

参考にした公式資料（2026-11-17確認）:

- [Material 3 — Lists](https://m3.material.io/components/lists/overview)
- [Material Components — Listの構成](https://github.com/material-components/material-components-android/blob/master/docs/components/List.md)
- [Compose — Card](https://developer.android.com/develop/ui/compose/components/card)
- [Compose — Segmented button](https://developer.android.com/develop/ui/compose/components/segmented-button)
- [Compose — Material 3の配色・文字・形状](https://developer.android.com/develop/ui/compose/designsystems/material3)
- [Compose — 標準のアクセシビリティとタップ領域](https://developer.android.com/develop/ui/compose/accessibility/api-defaults)
- [Compose — Semantics](https://developer.android.com/develop/ui/compose/accessibility/semantics)
