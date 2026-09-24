#!/usr/bin/env sh
set -eu
dir="$(dirname "$0")/../.tools/xerces"
mkdir -p "$dir"
m=https://repo1.maven.org/maven2
for path in \
  org/exist-db/thirdparty/xerces/xercesImpl/2.12.2/xercesImpl-2.12.2-xml-schema-1.1.jar \
  xml-apis/xml-apis/1.4.01/xml-apis-1.4.01.jar \
  xml-resolver/xml-resolver/1.2/xml-resolver-1.2.jar \
  edu/princeton/cup/java-cup/10k/java-cup-10k.jar \
  org/exist-db/thirdparty/org/eclipse/wst/xml/xpath2/1.2.0/xpath2-1.2.0.jar
do
  file="$dir/$(basename "$path")"
  [ -f "$file" ] || curl -sfo "$file" "$m/$path"
  expected="$(curl -sf "$m/$path.sha1" | cut -c1-40)"
  actual="$(sha1sum "$file" | cut -c1-40)"
  [ "$expected" = "$actual" ] || { echo "checksum mismatch: $file" >&2; rm -f "$file"; exit 1; }
done
echo "xsd 1.1 processor ready in $dir"
