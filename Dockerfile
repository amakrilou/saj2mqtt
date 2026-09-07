FROM node:16

WORKDIR /saj2mqtt

COPY package*.json ./
COPY tsconfig.json ./
COPY src /saj2mqtt/src

RUN npm install --omit=optional
RUN npm run build

EXPOSE 5000
EXPOSE 502

CMD [ "node", "./dist/index.js" ]
