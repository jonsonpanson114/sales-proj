"""index.html に埋め込んだGASソースが gas/sync.gs と一致するか確認する"""
import io, re, sys
html = io.open('index.html', encoding='utf-8').read()
m = re.search(r'    <script type="text/plain" id="gas-source">\n(.*?)    </script>\n    <!-- /gas-source -->\n', html, re.S)
if not m:
    print('!! 埋め込みブロックが見つからない'); sys.exit(1)
embedded = m.group(1)
disk = io.open('gas/sync.gs', encoding='utf-8').read()
if embedded == disk:
    print('一致: 埋め込みGASソース == gas/sync.gs (%d bytes)' % len(disk))
else:
    print('!! 不一致: embed_gas.py を再実行すること')
    print('   embedded=%d disk=%d' % (len(embedded), len(disk)))
    sys.exit(1)
