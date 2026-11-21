# Internal NewPipeExtractor sidecar. Not for the public internet: only the gateway should reach it.
FROM gradle:8.10-jdk17 AS build
WORKDIR /src
COPY settings.gradle build.gradle ./
COPY src ./src
RUN gradle --no-daemon installDist

FROM eclipse-temurin:17-jre
RUN useradd -r -u 10002 newpipe
WORKDIR /srv
COPY --from=build /src/build/install/zoyra-newpipe/ ./
USER newpipe
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8090/healthz || exit 1
CMD ["bin/zoyra-newpipe"]
