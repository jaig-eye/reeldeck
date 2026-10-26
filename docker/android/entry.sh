#!/bin/sh
# check  compile the native layer (the default; what to run before every tag)
# apk    assemble a debug APK and leave it in docker/out/
set -e
MODE="${1:-check}"
cd /repo/android

# Straight to the wrapper JAR rather than ./gradlew: on a Windows checkout the script can
# come out with CRLF endings, and `sh` then looks for an interpreter called "sh\r".
gradle() {
  java -Dorg.gradle.appname=gradlew \
       -classpath gradle/wrapper/gradle-wrapper.jar \
       org.gradle.wrapper.GradleWrapperMain --no-daemon --console=plain "$@"
}

case "$MODE" in
  check)
    echo "[android] compiling the release variant's Java..."
    gradle -q :app:compileReleaseJavaWithJavac
    echo "[android] OK - MainActivity and friends compile against SDK 34."
    ;;
  apk)
    if [ ! -d app/src/main/assets/public ]; then
      echo "[android] web assets are missing. On the host, run:  npm run web:build && npx cap copy android" >&2
      exit 1
    fi
    echo "[android] assembling a debug APK..."
    gradle -q assembleDebug
    mkdir -p /repo/docker/out
    cp app/build/outputs/apk/debug/app-debug.apk /repo/docker/out/Reeldeck-debug.apk
    echo "[android] docker/out/Reeldeck-debug.apk"
    echo "[android] NB: debug-signed. It installs on a clean device, not over a released build."
    ;;
  *)
    echo "usage: android [check|apk]" >&2; exit 2 ;;
esac
