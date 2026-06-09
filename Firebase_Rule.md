# Firebase Rules สำหรับโปรเจกต์นี้

เอกสารนี้สรุป Rules ที่ควรใช้ให้ตรงกับสถาปัตยกรรมของระบบนี้:

- ข้อมูลหลักเก็บใน Firestore (`testCases`, `testRuns`)
- รูป screenshot ไม่ใช้ Firebase Storage (ใช้ Local static server)
- Frontend ฟังข้อมูลด้วย `onSnapshot()`

## 1) Firestore Rules (โหมดที่ควรใช้ตอนนี้: มี Login/Register)

หลังเพิ่มหน้า Login/Register แล้ว แนะนำให้บังคับว่าเฉพาะผู้ใช้ที่ล็อกอินเท่านั้นจึงอ่านข้อมูลได้ และยังคงให้เขียนผ่าน Backend เท่านั้น

```txt
rules_version = '2';
service cloud.firestore {
	match /databases/{database}/documents {

		function isSignedIn() {
			return request.auth != null;
		}

		function isBackendWriter() {
			// เขียนจาก backend ผ่าน Firebase Admin SDK (server SDK bypass rules อยู่แล้ว)
			// ฝั่ง client จะถูกบล็อกการเขียนทั้งหมด
			return false;
		}

		match /testCases/{docId} {
			allow read: if isSignedIn();
			allow create, update, delete: if isBackendWriter();
		}

		match /testRuns/{docId} {
			allow read: if isSignedIn();
			allow create, update, delete: if isBackendWriter();
		}

		// ปิดทุก collection อื่นทั้งหมด
		match /{document=**} {
			allow read, write: if false;
		}
	}
}
```

หมายเหตุสำคัญ:

- ต้องเปิด Firebase Authentication (เช่น Email/Password) เพื่อให้ผู้ใช้ล็อกอินก่อนอ่านข้อมูล
- Backend ที่ใช้ `firebase-admin` จะเขียนได้แม้ rules จะเป็น `false` เพราะเป็น trusted server environment
- วิธีนี้ช่วยกันการเขียนจาก browser/client โดยตรง

## 2) Firestore Rules (โหมด Production เมื่อมี Auth)

ถ้าจะไป production แนะนำให้เปิด Auth แล้วอ่านเฉพาะผู้ใช้ที่ล็อกอิน

```txt
rules_version = '2';
service cloud.firestore {
	match /databases/{database}/documents {

		function isSignedIn() {
			return request.auth != null;
		}

		function isAdmin() {
			// ใช้เมื่อคุณต้องการให้บาง user (custom claim admin=true) เขียนข้อมูลจาก client ได้
			return request.auth != null && request.auth.token.admin == true;
		}

		match /testCases/{docId} {
			allow read: if isSignedIn();
			allow create, update, delete: if false; // แนะนำ: เขียนผ่าน backend admin เท่านั้น
			// ทางเลือก: allow create, update, delete: if isAdmin();
		}

		match /testRuns/{docId} {
			allow read: if isSignedIn();
			allow create, update, delete: if false; // แนะนำ: เขียนผ่าน backend admin เท่านั้น
			// ทางเลือก: allow create, update, delete: if isAdmin();
		}

		match /{document=**} {
			allow read, write: if false;
		}
	}
}
```

## 3) Firebase Storage Rules

โปรเจกต์นี้กำหนดให้ screenshot อยู่ Local Disk และเสิร์ฟผ่าน Express static
ดังนั้นใน Firebase Storage ให้ปิดทั้งหมด

```txt
rules_version = '2';
service firebase.storage {
	match /b/{bucket}/o {
		match /{allPaths=**} {
			allow read, write: if false;
		}
	}
}
```

## 4) Collections ที่ระบบใช้จริง

- `testCases`
	- read: frontend
	- write: backend (`save-generated`, `save-test`, `test-case-script`, update status)
- `testRuns`
	- read: frontend
	- write: backend (`execute`, update run result)

## 5) Checklist หลังวาง Rules

1. วาง Firestore Rules ใน Firebase Console -> Firestore Database -> Rules
2. วาง Storage Rules ใน Firebase Console -> Storage -> Rules
3. Publish Rules
4. ทดสอบจากหน้าเว็บ:
	 - Generate แล้วต้องเห็นข้อมูลใน `testCases`
	 - Execute แล้วต้องเห็นข้อมูลใน `testRuns`
 	 - Login/Logout ต้องควบคุมการเข้าถึงหน้า Dashboard/TestCases/Report ได้
5. ยืนยันว่า client เขียนตรงเข้า Firestore ไม่ได้ (ต้องผ่าน backend เท่านั้น)

