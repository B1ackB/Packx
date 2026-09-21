"""Reproduce the frozen FDA export transformation using only Python stdlib; no network."""
import csv
import hashlib
import io
import json
import re
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HEADERS = ["Recycle Number", "Date of NOL", "Company", "Polymer abbrev", "Polymer", "Recycling Process", "Use Limitations"]


class Text(HTMLParser):
	def __init__(self):
		super().__init__(convert_charrefs=True)
		self.parts = []
		self.lists = []

	def handle_starttag(self, tag, attrs):
		assert tag in {"br", "ol", "li", "sub"}, f"Unreviewed HTML tag: {tag}"
		assert not attrs, "Unreviewed HTML attributes"
		if tag == "ol":
			self.lists.append(0)
		elif tag == "li":
			assert self.lists
			self.lists[-1] += 1
			self.parts.append(f"\n{self.lists[-1]}. ")
		elif tag == "br":
			self.parts.append("\n")

	def handle_endtag(self, tag):
		assert tag in {"br", "ol", "li", "sub"}, f"Unreviewed HTML tag: {tag}"
		if tag == "ol":
			self.lists.pop()

	def handle_data(self, data):
		self.parts.append(data)


def plain(value):
	parser = Text()
	parser.feed(value)
	parser.close()
	assert not parser.lists
	return "\n".join(re.sub(r"[ \t]+", " ", line).strip() for line in "".join(parser.parts).splitlines()).strip()


raw = (ROOT / "fda-recycled-plastics.xls").read_bytes()
source = raw.decode("cp1252")
assert "Last updated 9/4/2026; downloaded 9/21/2026." in source
start = source.index(",".join(HEADERS))
rows = list(csv.reader(io.StringIO(source[start:]), strict=True))
assert rows[0] == HEADERS and len(rows) == 461
records = []
for row_index, row in enumerate(rows[1:], 1):
	assert len(row) == 7
	match = re.fullmatch(r'=T\("([0-9]+)"\)', row[0])
	assert match, "Only the documented numeric Excel wrapper is accepted; never evaluate formulas"
	record = dict(zip(HEADERS, [match[1], *[plain(cell) for cell in row[1:]]]))
	assert all(record[name] for name in HEADERS if name != "Polymer abbrev")
	record["Date of NOL"] = datetime.strptime(record["Date of NOL"], "%m/%d/%Y").strftime("%Y-%m-%d")
	records.append(record)
assert {int(r["Recycle Number"]) for r in records} == set(range(1, 461))
output = {"schemaVersion": "packx-fda-pcr-snapshot.v1", "updatedAt": "2026-09-04", "downloadedAt": "2026-09-21", "headers": HEADERS, "records": records}
encoded = (json.dumps(output, ensure_ascii=False, indent="\t") + "\n").encode()
(ROOT / "fda-recycled-plastics.json").write_bytes(encoded)
print(json.dumps({"rows": len(records), "rawSha256": hashlib.sha256(raw).hexdigest(), "recordsSha256": hashlib.sha256(encoded).hexdigest(), "maxFieldChars": max(len(v) for r in records for v in r.values())}, indent=2))
