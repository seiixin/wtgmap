require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion } = require('mongodb');

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB setup
const uri = process.env.MONGO_URI || 'mongodb+srv://happytooou:cFI51B3bXpjMWem9@walktograve.tfqc8vj.mongodb.net/walktograve?retryWrites=true&w=majority';
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function connectToDatabaseAndStartServer() {
  try {
    await client.connect();
    await client.db("walktograve").command({ ping: 1 });
    console.log("✅ Connected to MongoDB successfully!");

    // Routes
    app.get('/', (req, res) => {
      res.send('Server is running...');
    });

    // AdultGraves route
    app.get("/api/adultgraves", async (req, res) => {
      try {
        const db = client.db("walktograve");
        const collection = db.collection("adultgraves");

        const data = await collection.find({}).toArray();
        res.json(data);
      } catch (err) {
        console.error("❌ Error fetching adult graves:", err);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // Optional: Other route files
    const geoFeatureRoutes = require("./routes/GeoFeatureRoute"); // if exists
    app.use("/api/geofeatures", geoFeatureRoutes);

    const LastSeen = require("./routes/LastSeenRoute"); // if exists
    app.use("/api/last-seen", LastSeen);

    // Start server
    app.listen(port, () => {
      console.log(`🚀 Server is listening at http://localhost:${port}`);
    });

  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
  }
}

connectToDatabaseAndStartServer();
