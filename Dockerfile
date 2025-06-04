FROM node:18-slim

# Install qpdf
RUN apt-get update && apt-get install -y qpdf

# Set working directory
WORKDIR /usr/src

# Copy and install
COPY package*.json ./
RUN npm install

COPY . .

# Expose and start
EXPOSE 10000
CMD ["node", "index.js"]
