FROM node:20-alpine

WORKDIR /app

# Set a default environment variable for the port
ENV PORT=3000

COPY package*.json ./
RUN npm ci --only=production

COPY index.js ./

# Expose the variable port
EXPOSE $PORT

CMD ["npm", "start"]