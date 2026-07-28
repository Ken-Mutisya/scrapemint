FROM apify/actor-node:20

COPY --chown=myuser package*.json ./
RUN npm install --omit=dev --omit=optional \
  && npm list --omit=dev --omit=optional \
  || echo "npm list failed, continuing"

COPY --chown=myuser . ./

CMD npm start --silent
