"""gas/sync.gs を index.html の <script type="text/plain" id="gas-source"> に埋め込む。
   ソースの正はあくまで gas/sync.gs。このスクリプトを再実行すれば同期できる。"""
import io, re, sys

START = '    <script type="text/plain" id="gas-source">\n'
END = '    </script>\n    <!-- /gas-source -->\n'

gas = io.open('gas/sync.gs', encoding='utf-8').read()
for bad in ('`', '</script'):
    if bad in gas:
        print('!! GASソースに埋め込めない文字が含まれる:', bad); sys.exit(1)

html = io.open('index.html', encoding='utf-8').read()
block = START + gas + END

if '<!-- /gas-source -->' in html:
    html = re.sub(r'    <script type="text/plain" id="gas-source">\n.*?    </script>\n    <!-- /gas-source -->\n',
                  lambda m: block, html, flags=re.S)
else:
    anchor = '    <!-- MODALS -->\n'
    if html.count(anchor) != 1:
        print('!! アンカーが見つからない'); sys.exit(1)
    html = html.replace(anchor,
        '    <!-- GASスクリプト本体（設定画面からワンタップでコピーさせるために同梱。実行はされない） -->\n'
        + block + '\n' + anchor, 1)

io.open('index.html', 'w', encoding='utf-8').write(html)
print('埋め込み完了:', len(gas), 'bytes')
