# JDK 17 + Android SDK 34: compile the native layer BEFORE a tag is pushed.
#
# Why this exists: MainActivity once narrowed an inherited `public onResume()` to
# `protected`. A local javac could not tell that error from the ninety-nine caused by
# the SDK not being installed, so it shipped, CI failed, and a release went out with
# thirteen assets and an updater URL that 404'd. This container has the SDK:
#
#   docker compose run --rm android              compile only   (~1 min warm)
#   docker compose run --rm android apk          full debug APK -> docker/out/
#
# Built from first-party sources only: Eclipse Temurin and Google's own SDK tools.
FROM eclipse-temurin:17-jdk-jammy

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    GRADLE_USER_HOME=/gradle-cache
# Google's command-line tools, pinned. Bump the number when the platform level moves.
ARG CMDLINE_TOOLS=11076708
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends unzip curl >/dev/null \
 && mkdir -p $ANDROID_HOME/cmdline-tools \
 && curl -fsSL -o /tmp/tools.zip https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip \
 && unzip -q /tmp/tools.zip -d $ANDROID_HOME/cmdline-tools \
 && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
 && rm /tmp/tools.zip && rm -rf /var/lib/apt/lists/*
RUN yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null \
 && $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0" >/dev/null

COPY docker/android/entry.sh /usr/local/bin/entry.sh
# A Windows checkout can hand the script over with CRLF line endings, and `sh` then looks
# for an interpreter whose name ends in a carriage return. Strip them, whatever git did.
RUN tr -d '\015' < /usr/local/bin/entry.sh > /tmp/entry.sh \
 && mv /tmp/entry.sh /usr/local/bin/entry.sh && chmod +x /usr/local/bin/entry.sh
WORKDIR /repo/android
ENTRYPOINT ["/usr/local/bin/entry.sh"]
CMD ["check"]
