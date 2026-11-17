# Railway構成

`railway.ts`はAPI・共有worker・PostgreSQL・Redis・永続Volumeを定義します。
利用者のプロジェクトへリンクした`cloud/`から実行してください。

```sh
bun install --frozen-lockfile
railway config plan
railway config apply
```

Railway CLI 5.74.0で実環境との照合を確認しています。
既存リソースを取り込む場合は`railway config pull --variables=unmanaged`で
取り込み、planを確認してください。定義から消したリソースは削除対象になるため、
サービスやVolumeの削除が意図したものかを確認します。

変数は`managed: false`とし、秘密情報はRailwayのVariablesで管理します。
このファイルへキー・パスワード・接続URLを転記しないでください。
公開ドメインはAPIにのみ割り当てます。手順は[cloud/README.md](../README.md)を参照してください。

CPU・メモリの上限とAPIの休止設定は、現在のRailway側の設定を取り込んでいます。
上限値は予約リソースや同時利用人数の保証ではありません。APIの休止が有効な場合、
次のアクセスで起動を待つことがあります。ワーカーはジョブを継続監視します。
