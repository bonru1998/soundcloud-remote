#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${ANDROID_JAR:?Set ANDROID_JAR to Android SDK platform 35 android.jar}"
: "${BUILD_TOOLS:?Set BUILD_TOOLS to Android SDK build-tools 35.0.0}"
mkdir -p build/classes build/dex build/assets
cp ../ui/* build/assets/
"$BUILD_TOOLS/aapt2" compile --dir res -o build/resources.zip
"$BUILD_TOOLS/aapt2" link -o build/base.apk --manifest AndroidManifest.xml -I "$ANDROID_JAR" -A build/assets build/resources.zip
if command -v javac >/dev/null 2>&1; then
  javac -source 8 -target 8 -classpath "$ANDROID_JAR" -d build/classes src/dev/local/soundcloudremote/*.java
else
  : "${ECJ_JAR:?Install JDK 17 or set ECJ_JAR to Eclipse compiler 3.39.0}"
  java -jar "$ECJ_JAR" -8 -proc:none -classpath "$ANDROID_JAR" -d build/classes src/dev/local/soundcloudremote/*.java
fi
"$BUILD_TOOLS/d8" --lib "$ANDROID_JAR" --min-api 28 --output build/dex build/classes/dev/local/soundcloudremote/*.class
cp build/base.apk build/unsigned.apk
(cd build/dex && zip -q ../unsigned.apk classes.dex)
if [ ! -f debug.keystore ]; then
  keytool -genkeypair -keystore debug.keystore -storepass android -keypass android -alias androiddebugkey -dname "CN=SoundCloud Remote Development" -keyalg RSA -keysize 2048 -validity 10000
fi
"$BUILD_TOOLS/zipalign" -f 4 build/unsigned.apk build/aligned.apk
"$BUILD_TOOLS/apksigner" sign --ks debug.keystore --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android --out ../SoundCloud-Remote.apk build/aligned.apk
"$BUILD_TOOLS/apksigner" verify --verbose ../SoundCloud-Remote.apk
printf 'Built ../SoundCloud-Remote.apk\n'
