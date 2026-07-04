# Backend Connection Test Suite

## คำอธิบาย

ชุด test นี้ออกแบบมาเพื่อทดสอบการเชื่อมต่อ Backend และตรวจสอบว่าสามารถส่ง/รับผลลัพท์ได้อย่างถูกต้อง พร้อมการบันทึก error logs

## Test Cases

### 1. Health Check Test
ทดสอบว่า Backend ทำงานและตอบสนองต่อ health check endpoint

### 2. CORS Test
ตรวจสอบว่า CORS headers ถูกตั้งค่าอย่างถูกต้องและ request จากต่างไฟต้นทางทำงาน

### 3. Invalid Endpoint Test
ทดสอบการจัดการ request ที่ไม่ถูกต้องและควรส่ง 404 response

### 4. JSON Payload Test
ทดสอบการส่ง JSON payload และรับผลลัพท์กลับอย่างถูกต้อง

### 5. Large JSON Test
ทดสอบการจัดการ payload ขนาดใหญ่เพื่อตรวจสอบ limit การรับส่ง

### 6. Validation Test
ทดสอบการตรวจสอบ required fields และส่ง 400 response หากข้อมูลไม่ครบ

### 7. Timeout Test
ทดสอบการจัดการ timeout request อย่างถูกต้อง

## การใช้งาน

### วิธี 1: รัน test โดยการเรียก Backend ให้ทำงานแยก

ต้อง Terminal 1 รัน Backend:
```bash
cd backend
npm run dev
```

ต้อง Terminal 2 รัน test:
```bash
cd backend
npm run test:connection
```

### วิธี 2: รัน test แบบ end-to-end (เรียก Backend อัตโนมัติ)

```bash
cd backend
npm run test:run
```

วิธีนี้จะเรียก Backend ขึ้นมาอัตโนมัติ รอให้พร้อม แล้วรัน test

## Error Logging

ทุก error จะถูกบันทึกลงไฟล์ที่ตั้งอยู่ใน `logs/` directory

ไฟล์ log จะมีชื่อแบบนี้: `backend-connection-{timestamp}.json`

### Log Entry Structure

```json
{
  "timestamp": "2026-07-01T10:18:55.463Z",
  "level": "error|warn|info|success|debug",
  "message": "Test message",
  "data": {
    "status": 500,
    "error": "Error details..."
  },
  "stack": "Error stack trace (if applicable)"
}
```

## Logger Methods

- `logger.info(message, data?)` - บันทึกข้อมูลทั่วไป
- `logger.error(message, error?)` - บันทึก error พร้อมข้อมูล stack trace
- `logger.warn(message, data?)` - บันทึก warning
- `logger.success(message, data?)` - บันทึกความสำเร็จ
- `logger.debug(message, data?)` - บันทึก debug info (ต้องตั้ง DEBUG env var)

## Environment Variables

- `DEBUG=true` - เปิดใช้ debug logging

## ตัวอย่างการรัน

```bash
# Install dependencies (if not already installed)
npm install

# Run tests with automatic backend startup
npm run test:run

# Or run tests with manual backend control
# Terminal 1:
npm run dev

# Terminal 2:
npm run test:connection
```

## Output

Test suite จะแสดง:
- ✓ ความสำเร็จของแต่ละ test
- ❌ Error ที่เกิดขึ้น
- ⚠️  Warning ต่างๆ
- 📋 สรุปของ logs

และบันทึกรายละเอียดทั้งหมดไปยังไฟล์ JSON

## Troubleshooting

### Backend connection failed
- ตรวจสอบว่า Backend process ทำงานและ listen on port 4000
- ตรวจสอบ CORS configuration
- ดูไฟล์ log เพื่อดูรายละเอียด error

### Test timeout
- ตรวจสอบ network connection
- ลองรัน backend ใหม่
- ตรวจสอบว่า port 4000 ไม่ถูก block ด้วย firewall

### Firebase errors
- ตรวจสอบ .env configuration สำหรับ Firebase credentials
- ดูไฟล์ log เพื่อข้อมูลเพิ่มเติม

## ไฟล์ที่เกี่ยวข้อง

- `src/tests/backend-connection.test.ts` - Test suite
- `src/utils/logger.ts` - Logger utility
- `playwright.config.ts` - Playwright configuration
- `run-tests.ts` - Test runner script
