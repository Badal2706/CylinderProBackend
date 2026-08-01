[1mdiff --git a/package-lock.json b/package-lock.json[m
[1mindex 196e492..33d63cd 100644[m
[1m--- a/package-lock.json[m
[1m+++ b/package-lock.json[m
[36m@@ -23,6 +23,7 @@[m
         "nodemailer": "^9.0.3",[m
         "otplib": "^12.0.1",[m
         "qrcode": "^1.5.4",[m
[32m+[m[32m        "resend": "^6.18.0",[m[41m[m
         "winston": "^3.17.0",[m
         "xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"[m
       },[m
[36m@@ -119,6 +120,12 @@[m
         "text-hex": "1.0.x"[m
       }[m
     },[m
[32m+[m[32m    "node_modules/@stablelib/base64": {[m[41m[m
[32m+[m[32m      "version": "1.0.1",[m[41m[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@stablelib/base64/-/base64-1.0.1.tgz",[m[41m[m
[32m+[m[32m      "integrity": "sha512-1bnPQqSxSuc3Ii6MhBysoWCg58j97aUjuCSZrGSmDxNqtytIi0k8utUenAwTZN4V5mXXYGsVUI9zeBqy+jBOSQ==",[m[41m[m
[32m+[m[32m      "license": "MIT"[m[41m[m
[32m+[m[32m    },[m[41m[m
     "node_modules/@standard-schema/spec": {[m
       "version": "1.1.0",[m
       "resolved": "https://registry.npmjs.org/@standard-schema/spec/-/spec-1.1.0.tgz",[m
[36m@@ -1200,6 +1207,12 @@[m
       "integrity": "sha512-/d9sfos4yxzpwkDkuN7k2SqFKtYNmCTzgfEpz82x34IM9/zc8KGxQoXg1liNC/izpRM/MBdt44Nmx41ZWqk+FQ==",[m
       "license": "MIT"[m
     },[m
[32m+[m[32m    "node_modules/fast-sha256": {[m[41m[m
[32m+[m[32m      "version": "1.3.0",[m[41m[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/fast-sha256/-/fast-sha256-1.3.0.tgz",[m[41m[m
[32m+[m[32m      "integrity": "sha512-n11RGP/lrWEFI/bWdygLxhI+pVeo1ZYIVwvvPkW7azl/rOy+F3HYRZ2K5zeE9mmkhQppyv9sQFx0JM9UabnpPQ==",[m[41m[m
[32m+[m[32m      "license": "Unlicense"[m[41m[m
[32m+[m[32m    },[m[41m[m
     "node_modules/fecha": {[m
       "version": "4.2.3",[m
       "resolved": "https://registry.npmjs.org/fecha/-/fecha-4.2.3.tgz",[m
[36m@@ -2156,6 +2169,12 @@[m
         "node": ">=10.13.0"[m
       }[m
     },[m
[32m+[m[32m    "node_modules/postal-mime": {[m[41m[m
[32m+[m[32m      "version": "2.7.5",[m[41m[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/postal-mime/-/postal-mime-2.7.5.tgz",[m[41m[m
[32m+[m[32m      "integrity": "sha512-GNEXKvWFQnbgO5NlrGzVa0FmWzBZ24PersAWErttSg1Hjpf0ATxTwS5DOMGaOpTG6bUh5cTr7xi0jAD942wCJA==",[m[41m[m
[32m+[m[32m      "license": "MIT-0"[m[41m[m
[32m+[m[32m    },[m[41m[m
     "node_modules/process": {[m
       "version": "0.11.10",[m
       "resolved": "https://registry.npmjs.org/process/-/process-0.11.10.tgz",[m
[36m@@ -2326,6 +2345,27 @@[m
       "integrity": "sha512-NKN5kMDylKuldxYLSUfrbo5Tuzh4hd+2E8NPPX02mZtn1VuREQToYe/ZdlJy+J3uCpfaiGF05e7B8W0iXbQHmg==",[m
       "license": "ISC"[m
     },[m
[32m+[m[32m    "node_modules/resend": {[m[41m[m
[32m+[m[32m      "version": "6.18.0",[m[41m[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/resend/-/resend-6.18.0.tgz",[m[41m[m
[32m+[m[32m      "integrity": "sha512-EjxZ9AVzywJgOlUoIJe9ytBWVrfbUtJbjeoLnRSvpU1sv97Hh9DSwhw+k8kiujrG4Rg4bzTBsjlmwWWuoOxSug==",[m[41m[m
[32m+[m[32m      "license": "MIT",[m[41m[m
[32m+[m[32m      "dependencies": {[m[41m[m
[32m+[m[32m        "postal-mime": "2.7.5",[m[41m[m
[32m+[m[32m        "standardwebhooks": "1.0.0"[m[41m[m
[32m+[m[32m      },[m[41m[m
[32m+[m[32m      "engines": {[m[41m[m
[32m+[m[32m        "node": ">=20"[m[41m[m
[32m+[m[32m      },[m[41m[m
[32m+[m[32m      "peerDependencies": {[m[41m[m
[32m+[m[32m        "@react-email/render": "*"[m[41m[m
[32m+[m[32m      },[m[41m[m
[32m+[m[32m      "peerDependenciesMeta": {[m[41m[m
[32m+[m[32m        "@react-email/render": {[m[41m[m
[32m+[m[32m          "optional": true[m[41m[m
[32m+[m[32m        }[m[41m[m
[32m+[m[32m      }[m[41m[m
[32m+[m[32m    },[m[41m[m
     "node_modules/router": {[m
       "version": "2.2.0",[m
       "resolved": "https://registry.npmjs.org/router/-/router-2.2.0.tgz",[m
[36m@@ -2555,6 +2595,16 @@[m
         "node": "*"[m
       }[m
     },[m
[32m+[m[32m    "node_modules/standardwebhooks": {[m[41m[m
[32m+[m[32m      "version": "1.0.0",[m[41m[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/standardwebhooks/-/standardwebhooks-1.0.0.tgz",[m[41m[m
[32m+[m[32m      "integrity": "sha512-BbHGOQK9olHPMvQNHWul6MYlrRTAOKn03rOe4A8O3CLWhNf4YHBqq2HJKKC+sfqpxiBY52pNeesD6jIiLDz8jg==",[m[41m[m
[32m+[m[32m      "license": "MIT",[m[41m[m
[32m+[m[32m      "dependencies": {[m[41m[m
[32m+[m[32m        "@stablelib/base64": "^1.0.0",[m[41m[m
[32m+[m[32m        "fast-sha256": "^1.3.0"[m[41m[m
[32m+[m[32m      }[m[41m[m
[32m+[m[32m    },[m[41m[m
     "node_modules/statuses": {[m
       "version": "2.0.2",[m
       "resolved": "https://registry.npmjs.org/statuses/-/statuses-2.0.2.tgz",[m
[1mdiff --git a/package.json b/package.json[m
[1mindex 63326d3..c1c3206 100644[m
[1m--- a/package.json[m
[1m+++ b/package.json[m
[36m@@ -27,6 +27,7 @@[m
     "nodemailer": "^9.0.3",[m
     "otplib": "^12.0.1",[m
     "qrcode": "^1.5.4",[m
[32m+[m[32m    "resend": "^6.18.0",[m[41m[m
     "winston": "^3.17.0",[m
     "xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"[m
   },[m
