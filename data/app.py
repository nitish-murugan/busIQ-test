from flask import Flask, jsonify, request
from flask_cors import CORS
import time

app = Flask(__name__)
CORS(app)

longLat = [
  [77.692400, 11.441200],
  [77.692300, 11.441200],
  [77.692200, 11.441200],
  [77.692000, 11.441200],
  [77.691900, 11.441200],
  [77.691800, 11.441200],
  [77.691600, 11.441200],
  [77.691500, 11.441200]
]

flag = True
count = 0
busNumber = "TN 01 AA 0000"

@app.route('/')
def health():
    return jsonify({"status": "ok"})

@app.route('/data')
def data():
    global count
    count+=1
    return jsonify({
        "busNumber": busNumber,
        "latitude": longLat[count%9][1],
        "longitude": longLat[count%9][0],
        "timeStamp": time.strftime("%Y-%m-%d %H:%M:%S")
    })

@app.route('/change/bus', methods=['GET','POST'])
def changeBus():
    global busNumber

    if request.method == "POST":
        busNumber = request.form.get("busNumber", busNumber)

    return f"""
    <html>
        <body>
            <h2>Current Name: {busNumber}</h2>
            <form method="POST">
                <input type="text" name="busNumber" placeholder="Enter new bus number">
                <button type="submit">Update</button>
            </form>
        </body>
    </html>
    """

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)


"""
11°20'31.8"N 77°42'43.0"E
11°20'31.9"N 77°42'41.0"E
11°20'31.9"N 77°42'39.5"E

"""