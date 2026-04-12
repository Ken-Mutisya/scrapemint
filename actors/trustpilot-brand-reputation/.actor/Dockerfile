# Apify base image with Node.js and Playwright pre-installed
FROM apify/actor-node-playwright-chrome:20

# Copy package files and install production deps
COPY --chown=myuser package*.json ./
RUN npm install --omit=dev --omit=optional \
  && npm list --omit=dev --omit=optional \
  || echo "npm list failed, continuing"

# Copy the rest of the source
COPY --chown=myuser . ./

CMD ./start_xvfb_and_run_cmd.sh && npm start --silent
