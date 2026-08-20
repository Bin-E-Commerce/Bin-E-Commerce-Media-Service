FROM public.ecr.aws/lambda/nodejs:20 AS build

WORKDIR ${LAMBDA_TASK_ROOT}
COPY lambda/video-processor/package.json ./package.json
RUN npm install --omit=dev \
    && mkdir -p /opt/bin \
    && cp node_modules/ffmpeg-static/ffmpeg /opt/bin/ffmpeg \
    && chmod +x /opt/bin/ffmpeg

COPY dist/lambda/video-processor/index.js ./index.js

FROM public.ecr.aws/lambda/nodejs:20
COPY --from=build ${LAMBDA_TASK_ROOT} ${LAMBDA_TASK_ROOT}
COPY --from=build /opt/bin/ffmpeg /opt/bin/ffmpeg
CMD ["index.handler"]
