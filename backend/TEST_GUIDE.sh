#!/bin/bash

# Backend Connection Test - Demonstration Script
# This script shows how to run the backend connection tests

echo "================================"
echo "Backend Connection Test Suite"
echo "================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if we're in the backend directory
if [ ! -f "package.json" ] || [ ! -d "src/tests" ]; then
    echo -e "${RED}Error: Please run this script from the backend directory${NC}"
    exit 1
fi

echo -e "${YELLOW}📋 Available test commands:${NC}"
echo ""
echo "1. Run tests (requires backend to be running separately):"
echo "   ${GREEN}npm run test:connection${NC}"
echo ""
echo "2. Run tests with automatic backend startup:"
echo "   ${GREEN}npm run test:run${NC}"
echo ""
echo -e "${YELLOW}🚀 Quick Start:${NC}"
echo ""
echo "Option A - Manual backend control (recommended for development):"
echo "  1. ${GREEN}npm run dev${NC}              # Terminal 1: Start backend"
echo "  2. ${GREEN}npm run test:connection${NC}  # Terminal 2: Run tests"
echo ""
echo "Option B - Automatic backend startup and shutdown:"
echo "  ${GREEN}npm run test:run${NC}"
echo ""
echo -e "${YELLOW}📋 Test coverage includes:${NC}"
echo "  ✓ Backend health check"
echo "  ✓ CORS configuration"
echo "  ✓ JSON payload handling"
echo "  ✓ Request validation"
echo "  ✓ Large payload handling"
echo "  ✓ Timeout handling"
echo "  ✓ Error handling"
echo ""
echo -e "${YELLOW}📂 Test results:${NC}"
echo "  Logs: ${GREEN}./logs/backend-connection-*.json${NC}"
echo "  Report: ${GREEN}./playwright-report/index.html${NC}"
echo ""
