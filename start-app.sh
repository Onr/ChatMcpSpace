#!/bin/bash

echo "=== Starting AI Agent Messaging Platform ==="
echo ""

# Check if .env exists
echo "1. Checking environment configuration..."
if [ ! -f ".env" ]; then
    echo "Creating .env file from template..."
    cp .env.example .env
    echo "✓ .env file created with default settings"
else
    echo "✓ .env file exists"
fi

# Install dependencies
echo ""
echo "2. Installing Node.js dependencies..."
if [ -d "node_modules" ]; then
    echo "✓ Dependencies already installed"
else
    npm install
    echo "✓ Dependencies installed"
fi

echo ""
echo "=== Starting Application ==="
echo ""
echo "The app will be available at http://localhost:3000"
echo "Press Ctrl+C to stop the server"
echo ""

# Start the application
npm start
